/**
 * Pre-retrieval query analysis — uses the `queryAnalyse` model slot.
 * Parses the user's question into a QueryPlan that drives the MultiPathRetrievalEngine.
 * Falls back to a sensible default plan on LLM error or malformed JSON.
 */

import type {
  QueryAnalysisPort,
  QueryPlan,
  QueryPlanPath,
  QueryIntent,
  ResponseFormat,
  MemberContext,
} from "../../application/ports/QueryAnalysisPort";
import type { ChannelContext } from "../../application/ports/ClassifierPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the query planner for Jeeves, a discreet British team assistant.
Given a user's question, produce a JSON retrieval plan.

Intents:
- factual_recall: looking up a specific decision or action
- temporal_context: what happened recently / in a time period
- accountability: who owns what, who decided what
- institutional: policies, norms, team conventions
- dependency: what blocks what, what relates to what
- cross_channel: post-MVP, ignore for now

Paths to include (one or more):
- structured: SQL look-up of decisions/actions by owner/status/date/tag
- semantic: vector similarity search across stored embeddings
- graph: entity relationship traversal
- summary: pre-computed channel summaries (use for temporal_context and institutional intents)

Response formats: direct_answer | summary | list | comparison

Complexity: 0.0 = simple lookup, 1.0 = multi-source synthesis required

Return ONLY valid JSON — no markdown, no explanation:
{
  "intent": "<intent>",
  "entities": ["<name1>"],
  "timeRange": {"start": "<ISO8601 or null>", "end": "<ISO8601 or null>"} | null,
  "channels": null,
  "paths": [{"path": "<path>", "params": {}}],
  "responseFormat": "<format>",
  "complexity": <0.0-1.0>
}`;

const DEFAULT_PLAN: QueryPlan = {
  intent: "factual_recall",
  entities: [],
  timeRange: null,
  channels: null,
  paths: [
    { path: "structured", params: {} },
    { path: "semantic", params: {} },
  ],
  responseFormat: "direct_answer",
  complexity: 0.5,
};

export class OpenAIQueryAnalysisAdapter implements QueryAnalysisPort {
  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
  ) {}

  async analyse(
    question: string,
    channelContext: ChannelContext,
    members: MemberContext[],
  ): Promise<QueryPlan> {
    const memberBlock =
      members.length > 0
        ? `Team members: ${members.map((m) => m.name ?? m.id).join(", ")}\n`
        : "";
    const purposeBlock = channelContext.purpose ? `Channel purpose: ${channelContext.purpose}\n` : "";

    const userPrompt = `${purposeBlock}${memberBlock}Question: ${question}`;

    let raw: string;
    try {
      const result = await this.llm.chatCompletion(
        "queryAnalyse",
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        { max_tokens: 400, temperature: 0.1 },
      );
      raw = result.content;
    } catch (err) {
      this.logger.warn("QueryAnalysisAdapter: LLM call failed, using default plan", { err: String(err) });
      return DEFAULT_PLAN;
    }

    try {
      const json = stripJsonFence(raw);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return parsePlan(parsed);
    } catch {
      this.logger.warn("QueryAnalysisAdapter: malformed JSON, using default plan", { raw: raw.slice(0, 200) });
      return DEFAULT_PLAN;
    }
  }
}

function stripJsonFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

const VALID_INTENTS = new Set<string>([
  "factual_recall", "temporal_context", "cross_channel",
  "accountability", "institutional", "dependency",
]);
const VALID_FORMATS = new Set<string>(["direct_answer", "summary", "list", "comparison"]);
const VALID_PATHS = new Set<string>(["structured", "semantic", "graph", "summary"]);

function parsePlan(raw: Record<string, unknown>): QueryPlan {
  const intent: QueryIntent = VALID_INTENTS.has(raw.intent as string)
    ? (raw.intent as QueryIntent)
    : "factual_recall";

  const entities: string[] = Array.isArray(raw.entities)
    ? raw.entities.filter((e): e is string => typeof e === "string")
    : [];

  let timeRange: QueryPlan["timeRange"] = null;
  if (raw.timeRange && typeof raw.timeRange === "object") {
    const tr = raw.timeRange as Record<string, unknown>;
    timeRange = {
      start: tr.start && tr.start !== "null" ? new Date(tr.start as string) : undefined,
      end: tr.end && tr.end !== "null" ? new Date(tr.end as string) : undefined,
    };
  }

  const paths: QueryPlanPath[] = Array.isArray(raw.paths)
    ? (raw.paths as Array<Record<string, unknown>>)
        .filter((p) => VALID_PATHS.has(p.path as string))
        .map((p) => ({
          path: p.path as QueryPlanPath["path"],
          params: (typeof p.params === "object" && p.params !== null ? p.params : {}) as Record<string, unknown>,
        }))
    : DEFAULT_PLAN.paths;

  if (paths.length === 0) paths.push(...DEFAULT_PLAN.paths);

  // Auto-inject summary path for temporal/institutional intents when not already present
  if (
    (intent === "temporal_context" || intent === "institutional") &&
    !paths.some((p) => p.path === "summary")
  ) {
    paths.push({ path: "summary", params: {} });
  }

  const responseFormat: ResponseFormat = VALID_FORMATS.has(raw.responseFormat as string)
    ? (raw.responseFormat as ResponseFormat)
    : "direct_answer";

  const complexity = typeof raw.complexity === "number"
    ? Math.max(0, Math.min(1, raw.complexity))
    : 0.5;

  return {
    intent,
    entities,
    timeRange,
    channels: null,
    paths,
    responseFormat,
    complexity,
  };
}
