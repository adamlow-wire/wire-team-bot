/**
 * Port: Tier 2 — deep extraction of structured knowledge from a conversation window.
 * Receives the sliding window (last ≤30 messages) as context; NEVER stores verbatim content.
 */

import type { ChannelContext } from "./ClassifierPort";
import type {
  EntityType,
  ExtractedEntity,
  ExtractedRelationship,
  SignalType,
  ExtractedSignal,
} from "../../domain/entities/Extraction";

/** One message of the sliding window handed to Tier 2 extraction. Never persisted. */
export interface WindowMessage {
  messageId: string;
  authorId: string;
  authorName?: string;
  text: string;
  timestamp: Date;
}

// Extraction result types are domain concepts (repositories persist them); re-exported
// here so existing importers of the port keep working.
export type { EntityType, ExtractedEntity, ExtractedRelationship, SignalType, ExtractedSignal };

export interface ExtractedDecision {
  summary: string;
  rationale?: string;
  decidedBy: string[];  // participant names/IDs mentioned
  confidence: number;   // 0–1
  tags: string[];
}

export interface ExtractedAction {
  description: string;
  ownerName?: string;   // as mentioned in conversation
  deadline?: string;    // natural language if present (e.g. "Friday")
  confidence: number;
  tags: string[];
  /**
   * ID of a KnownAction this new action supersedes (e.g. an unassigned action that the
   * sender has just personally committed to).  When set, the pipeline closes the old
   * action and creates this one in its place.
   */
  supersedes?: string;
}

export interface ExtractedCompletion {
  /** ID of the KnownAction being completed (e.g. "ACT-0002"). */
  actionId: string;
  /** Optional brief note about the completion (synthesised, not verbatim). */
  note?: string;
}

export interface ExtractResult {
  decisions: ExtractedDecision[];
  actions: ExtractedAction[];
  /** Actions from the known-actions list that this message completes. */
  completions: ExtractedCompletion[];
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  signals: ExtractedSignal[];
}

/**
 * A known open action passed to the extractor as context.
 * Richer than a plain description string — includes ID and owner so the LLM can
 * reference them in `supersedes` / `completions` output fields.
 */
export interface KnownAction {
  id: string;
  description: string;
  assigneeName: string;
  /** rawMessageId of the message that produced this action — used to annotate the window. */
  rawMessageId?: string;
}

export interface ExtractionPort {
  /**
   * Extract structured knowledge from the conversation window.
   * @param currentMessage  The message that triggered extraction (high-signal).
   * @param window          Sliding window of recent messages (context).
   * @param context         Channel context (purpose, type).
   * @param knownEntities   Entity names already in the graph (to avoid re-inventing aliases).
   * @param knownActions    Open actions already recorded in this conversation (for dedup,
   *                        supersedes, and completion detection).
   */
  extract(
    currentMessage: WindowMessage,
    window: WindowMessage[],
    context: ChannelContext,
    knownEntities: string[],
    knownActions: KnownAction[],
  ): Promise<ExtractResult>;
}
