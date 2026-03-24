export type SummaryGranularity = "daily" | "weekly" | "on_demand";
export type SummarySentiment = "productive" | "contentious" | "blocked" | "routine";

export interface ConversationSummary {
  id: string;
  scopeType: "channel" | "topic" | "project" | "person";
  scopeId: string;
  organisationId: string;
  periodStart: Date;
  periodEnd: Date;
  granularity: SummaryGranularity;
  summary: string;
  /** Decision IDs referenced in this summary. */
  keyDecisions: string[];
  /** Action IDs referenced in this summary. */
  keyActions: string[];
  activeTopics: string[];
  participants: string[];
  sentiment?: SummarySentiment;
  messageCount?: number;
  modelVersion?: string;
  generatedAt: Date;
}
