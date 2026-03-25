/**
 * Port: Tier 1 — classify a single message and decide whether deep extraction is warranted.
 * Returns structured categories and a high-signal flag, NOT a single intent.
 *
 * TODO: Confirm qwen3-embedding:4b output dimensions before running the Phase 2 migration
 * to widen the embeddings.embedding column. Current default is 1024 (bge-m3:567m).
 * Set JEEVES_EMBED_DIMS accordingly if qwen3-embedding:4b uses 1536 dims.
 */

export type MessageCategory =
  | "decision"
  | "action"
  | "question"
  | "blocker"
  | "update"
  | "discussion"
  | "reference"
  | "routine";

export interface ClassifyResult {
  /** One or more applicable categories — a message may be both a 'decision' and an 'action'. */
  categories: MessageCategory[];
  /** LLM confidence in the classification (0–1). */
  confidence: number;
  /** Named entities mentioned in the message (used by Tier 2 as hints). */
  entities: string[];
  /** True if categories include 'decision', 'action', or 'blocker' — triggers Tier 2 extraction. */
  is_high_signal: boolean;
}

export interface ChannelContext {
  channelId: string;
  purpose?: string;
  contextType?: string;
}

export interface ClassifierPort {
  /**
   * Classify a single message.
   * @param text     The message text.
   * @param context  Channel context (purpose, type) for grounding.
   * @param window   Recent messages in the sliding window (for conversation context).
   */
  classify(text: string, context: ChannelContext, window: string[]): Promise<ClassifyResult>;
}
