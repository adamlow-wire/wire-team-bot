import type { UserResolutionService } from "../../domain/services/UserResolutionService";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { AuditLogRepository } from "../../domain/repositories/AuditLogRepository";
/**
 * ProcessingPipeline — three-tier background processing of conversation messages.
 *
 * Tier 1: Classify — determine if the message is high-signal.
 * Tier 2: Extract  — if high-signal, extract decisions / actions / entities / signals.
 * Tier 3: Embed    — asynchronously compute and store embedding vectors (fire-and-forget).
 *
 * Also: contradiction detection after decision insertion.
 *
 * This class is designed to be used as the worker function of InMemoryProcessingQueue.
 * All errors are caught and logged; the pipeline never throws.
 */

import type { ClassifierPort, ChannelContext } from "../../application/ports/ClassifierPort";
import type { ExtractionPort, KnownAction } from "../../application/ports/ExtractionPort";
import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { EntityRepository } from "../../domain/repositories/EntityRepository";
import type { EmbeddingRepository } from "../../domain/repositories/EmbeddingRepository";
import type { ConversationSignalRepository } from "../../domain/repositories/ConversationSignalRepository";
import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { ActionRepository } from "../../domain/repositories/ActionRepository";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { SlidingWindowBuffer } from "../buffer/SlidingWindowBuffer";
import type { Logger } from "../../application/ports/Logger";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { LLMClientFactory } from "../llm/LLMClientFactory";
import type { Decision } from "../../domain/entities/Decision";
import type { Action } from "../../domain/entities/Action";

export interface MessageJob {
  messageId: string;
  channelId: string;
  conversationId: QualifiedId;
  senderId: QualifiedId;
  senderName: string;
  text: string;
  timestamp: Date;
  /** Wire domain string used as org scope. */
  orgId: string;
}

export interface PipelineDeps {
  auditLog: AuditLogRepository;
  userResolution: UserResolutionService;
  dateTimeService: DateTimeService;
  classifier: ClassifierPort;
  extraction: ExtractionPort;
  embeddingService: EmbeddingService;
  entityRepo: EntityRepository;
  embeddingRepo: EmbeddingRepository;
  signalRepo: ConversationSignalRepository;
  decisionRepo: DecisionRepository;
  actionRepo: ActionRepository;
  channelConfig: ChannelConfigRepository;
  slidingWindow: SlidingWindowBuffer;
  wireOutbound: WireOutboundPort;
  llm: LLMClientFactory;
  logger: Logger;
  /** Minimum confidence to persist extracted decisions/actions (default 0.6). */
  extractConfidenceMin: number;
  /** Cosine similarity threshold for contradiction detection (default 0.78). */
  contradictionThreshold: number;
}

export class ProcessingPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async process(job: MessageJob, signal?: AbortSignal): Promise<void> {
    const { channelId, conversationId, senderId, senderName, text, timestamp, orgId, messageId } = job;
    const log = this.deps.logger.child({ channelId, messageId, senderName: senderName || undefined });

    // Get channel context for the classifier and extractor
    let channelCtx: ChannelContext;
    try {
      const cfg = await this.deps.channelConfig.get(channelId);
      if (signal?.aborted || (cfg && cfg.state !== "active")) return;
      channelCtx = {
        channelId,
        purpose: cfg?.purpose,
        contextType: cfg?.contextType ?? undefined,
        timezone: cfg?.timezone,
      };
    } catch {
      log.warn("Pipeline: channel state unavailable — processing stopped");
      return;
    }

    // ── Tier 1: Classify ────────────────────────────────────────────────────
    const window = this.deps.slidingWindow.getWindow(channelId);
    const windowTexts = window.map((m) => `[${m.authorName ?? m.authorId}] ${m.text}`);

    let classifyResult;
    try {
      classifyResult = await this.deps.classifier.classify(text, channelCtx, windowTexts);
    } catch (err) {
      log.warn("Pipeline: Tier 1 classify failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      // Write a fallback discussion signal and stop
      await this.writeSignal(channelId, orgId, messageId, timestamp, "discussion",
        "Unclassified message", [], 0.3, log, signal);
      return;
    }

    if (signal?.aborted) return;
    log.info("Pipeline: Tier 1 classify", {
      categories: classifyResult.categories,
      is_high_signal: classifyResult.is_high_signal,
      confidence: classifyResult.confidence,
    });

    if (!classifyResult.is_high_signal) {
      // Low-signal: write a lightweight discussion signal and stop
      const signalType = classifyResult.categories.includes("question") ? "question"
        : classifyResult.categories.includes("blocker") ? "blocker"
        : classifyResult.categories.includes("update") ? "update"
        : "discussion";
      await this.writeSignal(channelId, orgId, messageId, timestamp, signalType,
        "Conversation activity", classifyResult.entities, classifyResult.confidence, log, signal);
      return;
    }

    // ── Tier 2: Extract ─────────────────────────────────────────────────────
    const currentMsg = { messageId, authorId: senderId.id, authorName: senderName || undefined, text, timestamp };

    let knownEntities: string[] = [];
    try {
      knownEntities = await this.deps.entityRepo.listNames(channelId);
    } catch { /* non-fatal — extraction continues without hints */ }

    let knownActions: KnownAction[] = [];
    let openActions: Action[] = [];
    try {
      openActions = await this.deps.actionRepo.query({
        conversationId,
        statusIn: ["open", "in_progress"],
        limit: 10,
      });
      knownActions = openActions.map(a => ({
        id: a.id,
        description: a.description,
        assigneeName: a.assigneeName,
        rawMessageId: a.rawMessageId,
      }));
    } catch { /* non-fatal — extraction continues without dedup hints */ }

    if (signal?.aborted) return;
    let extracted;
    try {
      extracted = await this.deps.extraction.extract(currentMsg, window, channelCtx, knownEntities, knownActions);
    } catch (err) {
      log.error("Pipeline: Tier 2 extraction failed — writing fallback signal", { err: (err instanceof Error ? err.name : "UnknownError") });
      await this.writeSignal(channelId, orgId, messageId, timestamp, "discussion",
        "High-signal message — extraction failed", classifyResult.entities, 0.3, log, signal);
      return;
    }

    if (signal?.aborted) return;
    log.info("Pipeline: Tier 2 extract", {
      decisions: extracted.decisions.length,
      actions: extracted.actions.length,
      completions: extracted.completions.length,
      entities: extracted.entities.length,
      signals: extracted.signals.length,
    });

    const recentDecisions = await this.deps.decisionRepo.query({ conversationId, statusIn: ["active"], limit: 50 });
    const priorDecisions = await this.deps.decisionRepo.query({ conversationId, rawMessageId: messageId });
    const priorActions = await this.deps.actionRepo.query({ conversationId, rawMessageId: messageId });
    if (signal?.aborted) return;
    const decisionKeys = new Set((priorDecisions ?? []).map(d => `${d.rawMessageId}:${d.summary.trim().toLowerCase()}`));
    const actionKeys = new Set((priorActions ?? []).map(a => `${a.rawMessageId}:${a.description.trim().toLowerCase()}`));
    const now = new Date();

    // ── Entities (resolve IDs for relationship wiring) ────────────────────
    const entityNameToId = new Map<string, string>();
    for (const entity of extracted.entities) {
      if (signal?.aborted) return;
      try {
        const id = await this.deps.entityRepo.upsertWithDedup(entity, channelId, orgId);
        await this.audit(job, "Entity", id, "entity_updated");
        entityNameToId.set(entity.name.toLowerCase(), id);
        for (const alias of entity.aliases) {
          entityNameToId.set(alias.toLowerCase(), id);
        }
      } catch (err) {
        log.warn("Pipeline: entity upsert failed", { name: entity.name, err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    // ── Relationships ──────────────────────────────────────────────────────
    for (const rel of extracted.relationships) {
      if (signal?.aborted) return;
      const sourceId = entityNameToId.get(rel.sourceName.toLowerCase());
      const targetId = entityNameToId.get(rel.targetName.toLowerCase());
      if (!sourceId || !targetId) continue;
      try {
        await this.deps.entityRepo.upsertRelationship(sourceId, targetId, rel);
        await this.audit(job, "EntityRelationship", `${sourceId}:${targetId}:${rel.relationship}`, "entity_updated");
      } catch (err) {
        log.warn("Pipeline: relationship upsert failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    // ── Decisions ─────────────────────────────────────────────────────────
    const newDecisionIds: string[] = [];
    for (const d of extracted.decisions) {
      if (signal?.aborted) return;
      if (!Number.isFinite(d.confidence) || d.confidence < this.deps.extractConfidenceMin) continue;
      if ((recentDecisions ?? []).some(existing => normaliseFact(existing.summary) === normaliseFact(d.summary))) continue;
      const key = `${messageId}:${d.summary.trim().toLowerCase()}`;
      if (decisionKeys.has(key)) continue;
      decisionKeys.add(key);
      try {
        const validatedDeciders: string[] = [];
        for (const name of d.decidedBy) {
          const person = await this.deps.userResolution.resolveByHandleOrName(name, { conversationId });
          if (person.userId && !person.ambiguous) validatedDeciders.push(name);
        }
        if (signal?.aborted) return;
        const id = await this.deps.decisionRepo.nextId();
        if (signal?.aborted) return;
        const decision: Decision = {
          id,
          conversationId,
          authorId: senderId,
          authorName: senderName,
          rawMessageId: messageId,
          summary: d.summary,
          context: [],
          participants: [senderId],
          status: "active",
          supersededBy: null,
          supersedes: null,
          linkedIds: [],
          attachments: [],
          tags: d.tags,
          timestamp,
          updatedAt: now,
          deleted: false,
          version: 1,
          // Phase 2 extraction metadata
          decidedAt: timestamp,
          rationale: d.rationale,
          decidedBy: validatedDeciders,
          confidence: d.confidence,
          organisationId: orgId,
          sourceRef: {
            wire_msg_ids: [messageId],
            timestamp_range: { start: timestamp.toISOString(), end: timestamp.toISOString() },
          },
        };
        await this.deps.decisionRepo.create(decision);
        await this.audit(job, "Decision", id, "entity_created");
        newDecisionIds.push(id);

        // Tier 3: embed decision (fire-and-forget)
        await this.embedAndStore({
          text: d.summary,
          sourceType: "decision",
          sourceId: id,
          channelId,
          orgId,
          authorId: senderId.id,
          createdAt: timestamp,
          topicTags: d.tags,
        }, conversationId, log, signal);
      } catch (err) {
        log.warn("Pipeline: decision create failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    // ── Completions — close existing actions announced as done ─────────────
    for (const c of extracted.completions) {
      if (signal?.aborted) return;
      const target = openActions.find(a => a.id === c.actionId);
      if (!target || target.assigneeId.id !== senderId.id || target.assigneeId.domain !== senderId.domain) continue;
      try {
        await this.deps.actionRepo.update({
          ...target,
          status: "done",
          completionNote: c.note ?? null,
          updatedAt: now,
          version: target.version + 1,
        });
        await this.audit(job, "Action", target.id, "entity_updated");
        log.info("Pipeline: action completed via NL announcement", { actionId: target.id });
      } catch (err) {
        log.warn("Pipeline: completion update failed", { actionId: c.actionId, err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    // ── Actions ───────────────────────────────────────────────────────────
    for (const a of extracted.actions) {
      if (signal?.aborted) return;
      if (!Number.isFinite(a.confidence) || a.confidence < this.deps.extractConfidenceMin) continue;
      const key = `${messageId}:${a.description.trim().toLowerCase()}`;
      if (actionKeys.has(key)) continue;
      actionKeys.add(key);
      try {
        const resolved = a.ownerName
          ? await this.deps.userResolution.resolveByHandleOrName(a.ownerName, { conversationId })
          : { userId: null, ambiguous: false };
        if (signal?.aborted) return;
        if (!resolved.userId || resolved.ambiguous) {
          log.info("Pipeline: skipped action with unresolved owner");
          continue;
        }
        if (openActions.some(existing => normaliseFact(existing.description) === normaliseFact(a.description)
          && existing.assigneeId.id === resolved.userId!.id && existing.assigneeId.domain === resolved.userId!.domain)) continue;
        // Ownership corrections use the existing explicit reassign command. Passive
        // supersedes may be ambiguous and must not silently close someone else's work.
        if (a.supersedes) continue;

        const id = await this.deps.actionRepo.nextId();
        // Owner resolution: reject any UUID that leaked through from an unresolved
        // sender label, then fall back to senderName (display name) or empty.
        const resolvedOwner = looksLikeUuid(a.ownerName) ? undefined : a.ownerName;
        const resolvedSender = looksLikeUuid(senderName) ? "" : senderName;
        // Owner resolution: use sender as creator; ownerName may not map to a QualifiedId at MVP
        if (signal?.aborted) return;
        const action: Action = {
          id,
          conversationId,
          creatorId: senderId,
          authorName: resolvedSender,
          assigneeId: resolved.userId,
          assigneeName: resolvedOwner || resolvedSender || "",
          rawMessageId: messageId,
          description: a.description,
          deadline: a.deadline ? this.deps.dateTimeService.parse(a.deadline, { timezone: channelCtx.timezone ?? "UTC" })?.value ?? null : null,
          status: "open",
          linkedIds: [],
          reminderAt: [],
          completionNote: null,
          tags: a.tags,
          timestamp,
          updatedAt: now,
          deleted: false,
          version: 1,
          // Phase 2 extraction metadata
          actionConfidence: a.confidence,
          organisationId: orgId,
          sourceRef: {
            wire_msg_ids: [messageId],
            timestamp_range: { start: timestamp.toISOString(), end: timestamp.toISOString() },
          },
        };
        await this.deps.actionRepo.create(action);
        await this.audit(job, "Action", id, "entity_created");

        // Tier 3: embed action (fire-and-forget)
        await this.embedAndStore({
          text: a.description,
          sourceType: "action",
          sourceId: id,
          channelId,
          orgId,
          authorId: senderId.id,
          createdAt: timestamp,
          topicTags: a.tags,
        }, conversationId, log, signal);
      } catch (err) {
        log.warn("Pipeline: action create failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }

    // ── Signals ───────────────────────────────────────────────────────────
    for (const s of extracted.signals) {
      if (signal?.aborted) return;
      await this.writeSignal(channelId, orgId, messageId, timestamp,
        s.signalType, s.summary, s.tags, s.confidence, log, signal);
    }
    // Always write at least one signal for high-signal messages with no explicit signals
    if (extracted.signals.length === 0) {
      const signalType = extracted.decisions.length > 0 ? "update"
        : extracted.actions.length > 0 ? "update"
        : "discussion";
      await this.writeSignal(channelId, orgId, messageId, timestamp, signalType,
        "Conversation activity", classifyResult.entities, classifyResult.confidence, log, signal);
    }

    // ── Contradiction detection (async, non-blocking) ─────────────────────
    if (newDecisionIds.length > 0) {
      await this.checkContradictions(newDecisionIds, channelId, conversationId, log, signal);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async audit(job: MessageJob, entityType: string, entityId: string, action: "entity_created" | "entity_updated"): Promise<void> {
    await this.deps.auditLog.append({ timestamp: new Date(), actorId: job.senderId,
      conversationId: job.conversationId, entityType, entityId, action,
      details: { sourceMessageId: job.messageId } });
  }

  private async embedAndStore(params: {
    text: string;
    sourceType: string;
    sourceId: string;
    channelId: string;
    orgId: string;
    authorId: string;
    createdAt: Date;
    topicTags: string[];
  }, _convId: QualifiedId, log: Logger, signal?: AbortSignal): Promise<void> {
    try {
      if (signal?.aborted) return;
      const vector = await this.deps.embeddingService.embed(params.text);
      if (signal?.aborted || !vector || vector.length === 0) return;
      await this.deps.embeddingRepo.store({
        sourceType: params.sourceType as import("../../domain/repositories/EmbeddingRepository").EmbeddingSourceType,
        sourceId: params.sourceId,
        channelId: params.channelId,
        orgId: params.orgId,
        authorId: params.authorId,
        createdAt: params.createdAt,
        topicTags: params.topicTags,
        embedding: vector,
      });
    } catch (err) {
      log.warn("Pipeline: Tier 3 embed/store failed", { sourceId: params.sourceId, err: (err instanceof Error ? err.name : "UnknownError") });
    }
  }

  private async writeSignal(
    channelId: string,
    orgId: string,
    messageId: string,
    occurredAt: Date,
    signalType: import("../../application/ports/ExtractionPort").SignalType,
    summary: string,
    tags: string[],
    confidence: number,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (signal?.aborted) return;
      await this.deps.signalRepo.create({
        channelId,
        orgId,
        signalType,
        summary: summary.slice(0, 500),
        participants: [],
        tags,
        occurredAt,
        confidence,
        sourceRef: {
          wire_msg_ids: [messageId],
          timestamp_range: { start: occurredAt.toISOString(), end: occurredAt.toISOString() },
        },
      });
      await this.deps.auditLog.append({ timestamp: new Date(), actorId: { id: "wire-team-bot", domain: orgId },
        conversationId: { id: channelId.slice(0, channelId.lastIndexOf("@")), domain: orgId },
        action: "entity_created", entityType: "ConversationSignal", details: { sourceMessageId: messageId } });
    } catch (err) {
      log.warn("Pipeline: signal write failed", { err: (err instanceof Error ? err.name : "UnknownError") });
    }
  }

  private async checkContradictions(
    newDecisionIds: string[],
    channelId: string,
    conversationId: QualifiedId,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const decisionId of newDecisionIds) {
      try {
        if (signal?.aborted) return;
        await this.detectContradictionForDecision(decisionId, channelId, conversationId, log, signal);
      } catch (err) {
        log.warn("Contradiction check failed", { decisionId, err: (err instanceof Error ? err.name : "UnknownError") });
      }
    }
  }

  private async detectContradictionForDecision(
    decisionId: string,
    channelId: string,
    conversationId: QualifiedId,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<void> {
    const decision = await this.deps.decisionRepo.findById(decisionId);
    if (signal?.aborted || !decision) return;

    // Get embedding for the new decision
    const newEmbedding = await this.deps.embeddingService.embed(decision.summary);
    if (signal?.aborted || !newEmbedding || newEmbedding.length === 0) return;

    // Find similar decision embeddings in the channel (last 90 days)
    const similar = await this.deps.embeddingRepo.findSimilar(
      channelId,
      newEmbedding,
      5,
      "decision",
    );

    const thirtyMinutesMs = 30 * 60 * 1000;
    const now = Date.now();

    for (const candidate of similar) {
      if (!candidate.sourceId || candidate.sourceId === decisionId) continue;
      if (candidate.similarity < this.deps.contradictionThreshold) continue;

      const existing = await this.deps.decisionRepo.findById(candidate.sourceId);
      if (signal?.aborted) return;
      if (!existing || existing.status !== "active") continue;

      // Suppress if either decision is < 30 min old (might be the same conversation)
      const newAge = now - decision.timestamp.getTime();
      const existingAge = now - existing.timestamp.getTime();
      if (newAge < thirtyMinutesMs || existingAge < thirtyMinutesMs) continue;

      // Ask the classify model: "Does decision B contradict decision A?"
      const question = `Decision A: "${existing.summary}"\nDecision B: "${decision.summary}"\n\nDoes decision B contradict decision A? Answer only "yes" or "no".`;
      let answer: string;
      try {
        const result = await this.deps.llm.chatCompletion("classify", [
          { role: "user", content: question },
        ], { max_tokens: 5, temperature: 0 });
        answer = result.content.toLowerCase().trim();
      } catch {
        continue;
      }

      if (signal?.aborted) return;
      if (answer.startsWith("yes")) {
        log.info("Contradiction detected", { newDecisionId: decisionId, existingDecisionId: existing.id });
        try {
          await this.deps.wireOutbound.sendPlainText(
            conversationId,
            `One notes that a recent decision ("${decision.summary.slice(0, 80)}") appears to differ from an earlier one ("${existing.summary.slice(0, 80)}"). Review ${existing.id} and ${decisionId}. If the earlier decision is no longer valid, use: revoke ${existing.id} replaced by ${decisionId}.`,
          );
        } catch (err) {
          log.warn("Failed to send contradiction notice", { err: (err instanceof Error ? err.name : "UnknownError") });
        }
      }
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeUuid(s: string | undefined): boolean {
  return !!s && UUID_RE.test(s);
}

function normaliseFact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
