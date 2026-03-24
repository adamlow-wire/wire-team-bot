import type { ChannelContext } from "./ClassifierPort";

export type QueryIntent =
  | "factual_recall"
  | "temporal_context"
  | "cross_channel"
  | "accountability"
  | "institutional"
  | "dependency";

export type ResponseFormat = "direct_answer" | "summary" | "list" | "comparison";

export type RetrievalPathType = "structured" | "semantic" | "graph" | "summary";

export interface QueryPlanPath {
  path: RetrievalPathType;
  params: Record<string, unknown>;
}

export interface QueryPlan {
  intent: QueryIntent;
  entities: string[];
  timeRange: { start?: Date; end?: Date } | null;
  channels: string[] | null;
  paths: QueryPlanPath[];
  responseFormat: ResponseFormat;
  /**
   * Complexity score 0–1. When above config.complexityThreshold the respond slot
   * escalates to complexSynthesis for the generation call.
   */
  complexity: number;
}

export interface MemberContext {
  id: string;
  name?: string;
}

export interface QueryAnalysisPort {
  /**
   * Analyse a question and produce a retrieval plan.
   * @param question       The user's question.
   * @param channelContext Channel context (id, purpose, type).
   * @param members        Conversation members for personalisation.
   */
  analyse(
    question: string,
    channelContext: ChannelContext,
    members: MemberContext[],
  ): Promise<QueryPlan>;
}
