/**
 * Pre-retrieval query analysis — uses the `queryAnalyse` model slot.
 * Parses the user's question into a QueryPlan that drives the MultiPathRetrievalEngine.
 * Falls back to a sensible default plan on LLM error.
 * Uses Vercel AI SDK generateObject() with Zod schema — no manual JSON parsing.
 */

import { generateObject } from "ai";
import type {
  QueryAnalysisPort,
  QueryPlan,
  MemberContext,
} from "../../application/ports/QueryAnalysisPort";
import type { ChannelContext } from "../../application/ports/ClassifierPort";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";
import type { Logger } from "../../application/ports/Logger";
import { QueryPlanSchema } from "../../domain/schemas/queryAnalysis";

function buildSystemPrompt(botName: string): string {
  return `You are the query planner for ${botName}, a discreet team assistant.
Given a user's question, produce a structured retrieval plan.

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

Time ranges: use ISO8601 strings (e.g. "2026-01-01T00:00:00Z") or omit if not applicable.`;
}

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
    private readonly llm: VercelAISlotFactory,
    private readonly logger: Logger,
    private readonly botName: string = "Jeeves",
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

    const prompt = `${purposeBlock}${memberBlock}Question: ${question}`;

    try {
      const { object, usage } = await generateObject({
        model: this.llm.getModel("queryAnalyse"),
        schema: QueryPlanSchema,
        system: buildSystemPrompt(this.botName),
        prompt,
        maxRetries: 2,
      });

      this.logger.info("Pipeline: query analysis", {
        channelId: channelContext.channelId,
        intent: object.intent,
        paths: object.paths.map((p) => p.path),
        complexity: object.complexity,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        slot: "queryAnalyse",
      });

      return postProcess(object);
    } catch (err) {
      this.logger.warn("QueryAnalysisAdapter: LLM call failed, using default plan", { err: String(err) });
      return DEFAULT_PLAN;
    }
  }
}

/**
 * Applies business rules that the LLM should follow but may not always:
 * - structured path is always required (cheapest, most reliable)
 * - summary path is required for temporal_context and institutional intents
 * - timeRange strings are converted to Date objects
 */
function postProcess(raw: import("../../domain/schemas/queryAnalysis").QueryPlanRaw): QueryPlan {
  const paths = raw.paths.length > 0 ? [...raw.paths] : [...DEFAULT_PLAN.paths];

  if (!paths.some((p) => p.path === "structured")) {
    paths.unshift({ path: "structured", params: {} });
  }

  if (
    (raw.intent === "temporal_context" || raw.intent === "institutional") &&
    !paths.some((p) => p.path === "summary")
  ) {
    paths.push({ path: "summary", params: {} });
  }

  let timeRange: QueryPlan["timeRange"] = null;
  if (raw.timeRange) {
    const { start, end } = raw.timeRange;
    timeRange = {
      start: start ? new Date(start) : undefined,
      end: end ? new Date(end) : undefined,
    };
  }

  return {
    intent: raw.intent,
    entities: raw.entities,
    timeRange,
    channels: raw.channels,
    paths,
    responseFormat: raw.responseFormat,
    complexity: raw.complexity,
  };
}
