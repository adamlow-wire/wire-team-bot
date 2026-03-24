/**
 * Port: Tier 2 — deep extraction of structured knowledge from a conversation window.
 * Receives the sliding window (last ≤30 messages) as context; NEVER stores verbatim content.
 */

import type { WindowMessage } from "../../infrastructure/buffer/SlidingWindowBuffer";
import type { ChannelContext } from "./ClassifierPort";

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
}

export type EntityType = "person" | "service" | "project" | "team" | "tool" | "concept";

export interface ExtractedEntity {
  name: string;
  entityType: EntityType;
  aliases: string[];
  metadata?: Record<string, unknown>;
}

export interface ExtractedRelationship {
  sourceName: string;
  targetName: string;
  relationship: "owns" | "depends_on" | "works_on" | "blocks" | "reports_to";
  context?: string;
  confidence?: number;
}

export type SignalType = "discussion" | "question" | "blocker" | "update" | "concern";

export interface ExtractedSignal {
  signalType: SignalType;
  summary: string;    // 1–2 sentences synthesised — NO verbatim quotes
  tags: string[];
  confidence: number;
}

export interface ExtractResult {
  decisions: ExtractedDecision[];
  actions: ExtractedAction[];
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  signals: ExtractedSignal[];
}

export interface ExtractionPort {
  /**
   * Extract structured knowledge from the conversation window.
   * @param currentMessage  The message that triggered extraction (high-signal).
   * @param window          Sliding window of recent messages (context).
   * @param context         Channel context (purpose, type).
   * @param knownEntities   Entity names already in the graph (to avoid re-inventing aliases).
   */
  extract(
    currentMessage: WindowMessage,
    window: WindowMessage[],
    context: ChannelContext,
    knownEntities: string[],
  ): Promise<ExtractResult>;
}
