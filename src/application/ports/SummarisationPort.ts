import type { Decision } from "../../domain/entities/Decision";
import type { Action } from "../../domain/entities/Action";
import type { SummaryGranularity, SummarySentiment } from "../../domain/entities/ConversationSummary";

export interface SignalInput {
  signalType: string;
  summary: string;
  occurredAt: Date;
  participants: string[];
  tags: string[];
}

export interface SummaryResult {
  summary: string;
  /** IDs of decisions referenced. */
  keyDecisions: string[];
  /** IDs of actions referenced. */
  keyActions: string[];
  activeTopics: string[];
  participants: string[];
  sentiment: SummarySentiment;
  messageCount: number;
  modelVersion?: string;
}

export interface SummarisationPort {
  summarise(
    channelId: string,
    signals: SignalInput[],
    decisions: Decision[],
    actions: Action[],
    priorSummary: string | null,
    granularity: SummaryGranularity,
  ): Promise<SummaryResult>;
}
