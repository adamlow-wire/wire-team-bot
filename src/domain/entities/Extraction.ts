/**
 * Structured knowledge extracted from conversation windows (Tier 2 output).
 * These are domain concepts: repositories persist them and use cases reason about them.
 * Raw message text is never part of these types.
 */

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

/**
 * Signals that the triggering message announces completion of an existing open action.
 * The pipeline uses this to mark the referenced action as done rather than creating a
 * new action from a past-tense completion announcement.
 */
