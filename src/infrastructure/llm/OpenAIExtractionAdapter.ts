/**
 * Tier 2 Extractor — uses the `extract` model slot (larger, higher-quality model).
 * Receives the sliding window for context. Extracts decisions, actions, entities,
 * relationships, and signals from the conversation. NEVER stores verbatim content.
 *
 * On failure (timeout, malformed JSON): logs error and returns a fallback discussion signal.
 */

import type { ExtractionPort, ExtractResult, ExtractedDecision, ExtractedAction, ExtractedEntity, ExtractedRelationship, ExtractedSignal, EntityType, SignalType } from "../../application/ports/ExtractionPort";
import type { ChannelContext } from "../../application/ports/ClassifierPort";
import type { WindowMessage } from "../buffer/SlidingWindowBuffer";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the Tier 2 knowledge extractor for Jeeves, a discreet British team assistant.

Extract structured knowledge from the TRIGGERING MESSAGE ONLY. Use the conversation window purely as context to resolve ambiguous references (pronouns, "it", "that", "this", unnamed actors) — do not extract new facts from window messages as those have already been processed.

CRITICAL: Never include verbatim quotes. Synthesise and summarise only. The source text is discarded after extraction.

Extract from the triggering message:
- decisions: firm conclusions or choices made ("we agreed to...", "we're going with...", "decided that...")
- actions: clear commitments with an owner ("Alice will...", "Bob to...") — not vague intentions
- entities: named things (person, service, project, team, tool, concept)
- relationships: typed edges between entities
- signals: lightweight notes about the conversation (discussion | question | blocker | update | concern)

Valid entity types: person, service, project, team, tool, concept
Valid relationship types: owns, depends_on, works_on, blocks, reports_to
Valid signal types: discussion, question, blocker, update, concern

Return ONLY valid JSON — no markdown, no explanation:
{
  "decisions": [{"summary":"<synthesised>","rationale":"<why if clear>","decided_by":["<name>"],"confidence":<0-1>,"tags":["<tag>"]}],
  "actions": [{"description":"<synthesised>","owner_name":"<name>","deadline":"<expression or null>","confidence":<0-1>,"tags":["<tag>"]}],
  "entities": [{"name":"<name>","entity_type":"<type>","aliases":["<alt>"],"metadata":{}}],
  "relationships": [{"source_name":"<name>","target_name":"<name>","relationship":"<type>","context":"<brief>","confidence":<0-1>}],
  "signals": [{"signal_type":"<type>","summary":"<1-2 sentence synthesised note>","tags":["<tag>"],"confidence":<0-1>}]
}

If nothing to extract in a category, return an empty array.`;

const VALID_ENTITY_TYPES: EntityType[] = ["person", "service", "project", "team", "tool", "concept"];
const VALID_SIGNAL_TYPES: SignalType[] = ["discussion", "question", "blocker", "update", "concern"];
const VALID_RELATIONSHIPS = ["owns", "depends_on", "works_on", "blocks", "reports_to"];

const EMPTY_RESULT: ExtractResult = {
  decisions: [],
  actions: [],
  entities: [],
  relationships: [],
  signals: [],
};

export class OpenAIExtractionAdapter implements ExtractionPort {
  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
  ) {}

  async extract(
    currentMessage: WindowMessage,
    window: WindowMessage[],
    context: ChannelContext,
    knownEntities: string[],
  ): Promise<ExtractResult> {
    const purposeLine = context.purpose ? `Channel purpose: ${context.purpose}\n` : "";
    const contextTypeLine = context.contextType ? `Channel type: ${context.contextType}\n` : "";
    const knownLine = knownEntities.length > 0
      ? `Known entities in channel (do not re-extract unless information changes): ${knownEntities.slice(0, 30).join(", ")}\n`
      : "";

    const windowText = window.map((m) => `[${m.authorName ?? m.authorId}] ${m.text}`).join("\n");
    const senderLabel = currentMessage.authorName ?? currentMessage.authorId;
    const currentLine = `[${senderLabel}] ${currentMessage.text}`;

    const userContent = [
      purposeLine + contextTypeLine + knownLine,
      "Conversation window (oldest first):",
      windowText || "(none)",
      "",
      `Triggering message: ${currentLine}`,
    ].join("\n");

    let raw: string;
    try {
      const result = await this.llm.chatCompletion("extract", [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ], { max_tokens: 1500, temperature: 0 });
      raw = result.content;

      if (result.usedFallback) {
        this.logger.info("Extractor used fallback model", { channelId: context.channelId });
      }
    } catch (err) {
      this.logger.error("Extractor LLM call failed — writing fallback signal", {
        channelId: context.channelId,
        err: String(err),
      });
      return EMPTY_RESULT;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim()) as Record<string, unknown>;
    } catch {
      this.logger.warn("Extractor — failed to parse LLM response", {
        channelId: context.channelId,
        preview: raw.slice(0, 300),
      });
      return EMPTY_RESULT;
    }

    const decisions = this.parseDecisions(parsed.decisions);
    const actions = this.parseActions(parsed.actions);
    const entities = this.parseEntities(parsed.entities);
    const relationships = this.parseRelationships(parsed.relationships);
    const signals = this.parseSignals(parsed.signals);

    this.logger.debug("Extractor result", {
      channelId: context.channelId,
      decisions: decisions.length,
      actions: actions.length,
      entities: entities.length,
      relationships: relationships.length,
      signals: signals.length,
    });

    return { decisions, actions, entities, relationships, signals };
  }

  private parseDecisions(raw: unknown): ExtractedDecision[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      const summary = typeof r.summary === "string" ? r.summary.trim() : "";
      if (!summary) return [];
      return [{
        summary,
        rationale: typeof r.rationale === "string" ? r.rationale.trim() : undefined,
        decidedBy: Array.isArray(r.decided_by)
          ? r.decided_by.filter((x): x is string => typeof x === "string")
          : [],
        confidence: clamp(Number(r.confidence ?? 0.7)),
        tags: Array.isArray(r.tags)
          ? r.tags.filter((x): x is string => typeof x === "string")
          : [],
      }];
    });
  }

  private parseActions(raw: unknown): ExtractedAction[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      const description = typeof r.description === "string" ? r.description.trim() : "";
      if (!description) return [];
      return [{
        description,
        ownerName: typeof r.owner_name === "string" ? r.owner_name.trim() : undefined,
        deadline: typeof r.deadline === "string" && r.deadline !== "null" ? r.deadline : undefined,
        confidence: clamp(Number(r.confidence ?? 0.7)),
        tags: Array.isArray(r.tags)
          ? r.tags.filter((x): x is string => typeof x === "string")
          : [],
      }];
    });
  }

  private parseEntities(raw: unknown): ExtractedEntity[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name) return [];
      const entityType = VALID_ENTITY_TYPES.includes(r.entity_type as EntityType)
        ? (r.entity_type as EntityType)
        : "concept";
      return [{
        name,
        entityType,
        aliases: Array.isArray(r.aliases)
          ? r.aliases.filter((x): x is string => typeof x === "string")
          : [],
        metadata: typeof r.metadata === "object" && r.metadata !== null
          ? (r.metadata as Record<string, unknown>)
          : {},
      }];
    });
  }

  private parseRelationships(raw: unknown): ExtractedRelationship[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      const sourceName = typeof r.source_name === "string" ? r.source_name.trim() : "";
      const targetName = typeof r.target_name === "string" ? r.target_name.trim() : "";
      if (!sourceName || !targetName) return [];
      const relationship = VALID_RELATIONSHIPS.includes(r.relationship as string)
        ? (r.relationship as ExtractedRelationship["relationship"])
        : "works_on";
      return [{
        sourceName,
        targetName,
        relationship,
        context: typeof r.context === "string" ? r.context.trim() : undefined,
        confidence: clamp(Number(r.confidence ?? 0.7)),
      }];
    });
  }

  private parseSignals(raw: unknown): ExtractedSignal[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const r = item as Record<string, unknown>;
      const summary = typeof r.summary === "string" ? r.summary.trim() : "";
      if (!summary) return [];
      const signalType = VALID_SIGNAL_TYPES.includes(r.signal_type as SignalType)
        ? (r.signal_type as SignalType)
        : "discussion";
      return [{
        signalType,
        summary,
        tags: Array.isArray(r.tags)
          ? r.tags.filter((x): x is string => typeof x === "string")
          : [],
        confidence: clamp(Number(r.confidence ?? 0.6)),
      }];
    });
  }
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, isNaN(n) ? 0.5 : n));
}
