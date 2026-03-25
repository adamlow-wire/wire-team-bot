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
import type { ExtractionPort, ExtractedEntity } from "../../application/ports/ExtractionPort";
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

  async process(job: MessageJob): Promise<void> {
    const { channelId, conversationId, senderId, senderName, text, timestamp, orgId, messageId } = job;
    const log = this.deps.logger.child({ channelId, messageId });

    // Get channel context for the classifier and extractor
    let channelCtx: ChannelContext;
    try {
      const cfg = await this.deps.channelConfig.get(channelId);
      channelCtx = {
        channelId,
        purpose: cfg?.purpose,
        contextType: cfg?.contextType ?? undefined,
      };
    } catch {
      channelCtx = { channelId };
    }

    // ── Tier 1: Classify ────────────────────────────────────────────────────
    const window = this.deps.slidingWindow.getWindow(channelId);
    const windowTexts = window.map((m) => `[${m.authorName ?? m.authorId}] ${m.text}`);

    let classifyResult;
    try {
      classifyResult = await this.deps.classifier.classify(text, channelCtx, windowTexts);
    } catch (err) {
      log.warn("Pipeline: Tier 1 classify failed", { err: String(err) });
      // Write a fallback discussion signal and stop
      await this.writeSignal(channelId, orgId, messageId, timestamp, "discussion",
        "Unclassified message", [], 0.3, log);
      return;
    }

    log.debug("Pipeline: Tier 1 result", {
      categories: classifyResult.categories,
      is_high_signal: classifyResult.is_high_signal,
    });

    if (!classifyResult.is_high_signal) {
      // Low-signal: write a lightweight discussion signal and stop
      const signalType = classifyResult.categories.includes("question") ? "question"
        : classifyResult.categories.includes("blocker") ? "blocker"
        : classifyResult.categories.includes("update") ? "update"
        : "discussion";
      await this.writeSignal(channelId, orgId, messageId, timestamp, signalType,
        text.slice(0, 200), classifyResult.entities, classifyResult.confidence, log);
      return;
    }

    // ── Tier 2: Extract ─────────────────────────────────────────────────────
    const currentMsg = { messageId, authorId: senderId.id, authorName: senderName || undefined, text, timestamp };

    let knownEntities: string[] = [];
    try {
      knownEntities = await this.deps.entityRepo.listNames(channelId);
    } catch { /* non-fatal — extraction continues without hints */ }

    let extracted;
    try {
      extracted = await this.deps.extraction.extract(currentMsg, window, channelCtx, knownEntities);
    } catch (err) {
      log.error("Pipeline: Tier 2 extraction failed — writing fallback signal", { err: String(err) });
      await this.writeSignal(channelId, orgId, messageId, timestamp, "discussion",
        "High-signal message — extraction failed", classifyResult.entities, 0.3, log);
      return;
    }

    log.debug("Pipeline: Tier 2 result", {
      decisions: extracted.decisions.length,
      actions: extracted.actions.length,
      entities: extracted.entities.length,
      signals: extracted.signals.length,
    });

    const sourceRef = {
      wire_msg_ids: [messageId],
      timestamp_range: { start: timestamp.toISOString(), end: timestamp.toISOString() },
    };
    const now = new Date();

    // ── Entities (resolve IDs for relationship wiring) ────────────────────
    const entityNameToId = new Map<string, string>();
    for (const entity of extracted.entities) {
      try {
        const id = await this.deps.entityRepo.upsertWithDedup(entity, channelId, orgId);
        entityNameToId.set(entity.name.toLowerCase(), id);
        for (const alias of entity.aliases) {
          entityNameToId.set(alias.toLowerCase(), id);
        }
      } catch (err) {
        log.warn("Pipeline: entity upsert failed", { name: entity.name, err: String(err) });
      }
    }

    // ── Relationships ──────────────────────────────────────────────────────
    for (const rel of extracted.relationships) {
      const sourceId = entityNameToId.get(rel.sourceName.toLowerCase());
      const targetId = entityNameToId.get(rel.targetName.toLowerCase());
      if (!sourceId || !targetId) continue;
      try {
        await this.deps.entityRepo.upsertRelationship(sourceId, targetId, rel);
      } catch (err) {
        log.warn("Pipeline: relationship upsert failed", { err: String(err) });
      }
    }

    // ── Decisions ─────────────────────────────────────────────────────────
    const newDecisionIds: string[] = [];
    for (const d of extracted.decisions) {
      if (d.confidence < this.deps.extractConfidenceMin) continue;
      try {
        const id = await this.deps.decisionRepo.nextId();
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
          decidedBy: d.decidedBy,
          confidence: d.confidence,
          organisationId: orgId,
          sourceRef: {
            wire_msg_ids: [messageId],
            timestamp_range: { start: timestamp.toISOString(), end: timestamp.toISOString() },
          },
        };
        await this.deps.decisionRepo.create(decision);
        newDecisionIds.push(id);

        // Tier 3: embed decision (fire-and-forget)
        void this.embedAndStore({
          text: d.summary,
          sourceType: "decision",
          sourceId: id,
          channelId,
          orgId,
          authorId: senderId.id,
          createdAt: timestamp,
          topicTags: d.tags,
        }, conversationId, log);
      } catch (err) {
        log.warn("Pipeline: decision create failed", { err: String(err) });
      }
    }

    // ── Actions ───────────────────────────────────────────────────────────
    for (const a of extracted.actions) {
      if (a.confidence < this.deps.extractConfidenceMin) continue;
      try {
        const id = await this.deps.actionRepo.nextId();
        // Owner resolution: use sender as creator; ownerName may not map to a QualifiedId at MVP
        const action: Action = {
          id,
          conversationId,
          creatorId: senderId,
          authorName: senderName,
          assigneeId: senderId,
          assigneeName: a.ownerName ?? senderName,
          rawMessageId: messageId,
          description: a.description,
          deadline: null,  // natural language deadline deferred to Phase 3 (NLP parsing)
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

        // Tier 3: embed action (fire-and-forget)
        void this.embedAndStore({
          text: a.description,
          sourceType: "action",
          sourceId: id,
          channelId,
          orgId,
          authorId: senderId.id,
          createdAt: timestamp,
          topicTags: a.tags,
        }, conversationId, log);
      } catch (err) {
        log.warn("Pipeline: action create failed", { err: String(err) });
      }
    }

    // ── Signals ───────────────────────────────────────────────────────────
    for (const s of extracted.signals) {
      await this.writeSignal(channelId, orgId, messageId, timestamp,
        s.signalType, s.summary, s.tags, s.confidence, log);
    }
    // Always write at least one signal for high-signal messages with no explicit signals
    if (extracted.signals.length === 0) {
      const signalType = extracted.decisions.length > 0 ? "update"
        : extracted.actions.length > 0 ? "update"
        : "discussion";
      await this.writeSignal(channelId, orgId, messageId, timestamp, signalType,
        text.slice(0, 200), classifyResult.entities, classifyResult.confidence, log);
    }

    // ── Contradiction detection (async, non-blocking) ─────────────────────
    if (newDecisionIds.length > 0) {
      void this.checkContradictions(newDecisionIds, channelId, conversationId, log);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async embedAndStore(params: {
    text: string;
    sourceType: string;
    sourceId: string;
    channelId: string;
    orgId: string;
    authorId: string;
    createdAt: Date;
    topicTags: string[];
  }, _convId: QualifiedId, log: Logger): Promise<void> {
    try {
      const vector = await this.deps.embeddingService.embed(params.text);
      if (!vector || vector.length === 0) return;
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
      log.warn("Pipeline: Tier 3 embed/store failed", { sourceId: params.sourceId, err: String(err) });
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
  ): Promise<void> {
    try {
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
    } catch (err) {
      log.warn("Pipeline: signal write failed", { err: String(err) });
    }
  }

  private async checkContradictions(
    newDecisionIds: string[],
    channelId: string,
    conversationId: QualifiedId,
    log: Logger,
  ): Promise<void> {
    for (const decisionId of newDecisionIds) {
      try {
        await this.detectContradictionForDecision(decisionId, channelId, conversationId, log);
      } catch (err) {
        log.warn("Contradiction check failed", { decisionId, err: String(err) });
      }
    }
  }

  private async detectContradictionForDecision(
    decisionId: string,
    channelId: string,
    conversationId: QualifiedId,
    log: Logger,
  ): Promise<void> {
    const decision = await this.deps.decisionRepo.findById(decisionId);
    if (!decision) return;

    // Get embedding for the new decision
    const newEmbedding = await this.deps.embeddingService.embed(decision.summary);
    if (!newEmbedding || newEmbedding.length === 0) return;

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

      if (answer.startsWith("yes")) {
        log.info("Contradiction detected", { newDecisionId: decisionId, existingDecisionId: existing.id });
        try {
          await this.deps.wireOutbound.sendPlainText(
            conversationId,
            `One notes that a recent decision ("${decision.summary.slice(0, 80)}") appears to differ from an earlier one ("${existing.summary.slice(0, 80)}"). Shall I mark the earlier decision as superseded, or is this a separate matter?`,
          );
        } catch (err) {
          log.warn("Failed to send contradiction notice", { err: String(err) });
        }
      }
    }
  }
}
