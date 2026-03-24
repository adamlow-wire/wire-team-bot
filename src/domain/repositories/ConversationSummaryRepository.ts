import type { ConversationSummary, SummaryGranularity } from "../entities/ConversationSummary";

export type NewConversationSummary = Omit<ConversationSummary, "id" | "generatedAt">;

export interface ConversationSummaryRepository {
  /** Upsert a summary (unique on scopeType + scopeId + granularity + periodStart). */
  save(summary: NewConversationSummary): Promise<ConversationSummary>;
  /** Most recent summary of the given granularity for a channel. */
  findLatest(channelId: string, granularity: SummaryGranularity): Promise<ConversationSummary | null>;
  /** All summaries whose period overlaps the given range. */
  findForPeriod(channelId: string, start: Date, end: Date): Promise<ConversationSummary[]>;
}
