/**
 * Summary retrieval path — fetches stored channel summaries for the query's time range.
 * When no explicit time range is in the plan, returns the most recent daily summary.
 * Falls back gracefully to empty results on any error.
 */

import type { RetrievalResult, RetrievalScope } from "../../application/ports/RetrievalPort";
import type { QueryPlan } from "../../application/ports/QueryAnalysisPort";
import type { ConversationSummaryRepository } from "../../domain/repositories/ConversationSummaryRepository";
import type { Logger } from "../../application/ports/Logger";

/** Default lookback when no time range specified (7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export class SummaryRetrievalPath {
  constructor(
    private readonly summaryRepo: ConversationSummaryRepository,
    private readonly logger: Logger,
  ) {}

  async retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]> {
    if (!scope.channelId) return [];

    try {
      const now = new Date();

      if (plan.timeRange) {
        const start = plan.timeRange.start ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);
        const end = plan.timeRange.end ?? now;
        const summaries = await this.summaryRepo.findForPeriod(scope.channelId, start, end);
        return summaries.map((s) => summaryToResult(s, scope.channelId!));
      }

      // No time range — use most recent daily summary
      const latest = await this.summaryRepo.findLatest(scope.channelId, "daily");
      if (!latest) return [];
      return [summaryToResult(latest, scope.channelId)];
    } catch (err) {
      this.logger.warn("SummaryRetrievalPath: query failed", {
        channelId: scope.channelId,
        err: String(err),
      });
      return [];
    }
  }
}

function summaryToResult(
  s: { id: string; summary: string; periodStart: Date; periodEnd: Date; sentiment?: string; granularity: string },
  channelId: string,
): RetrievalResult {
  const period = `${s.periodStart.toISOString().slice(0, 10)} → ${s.periodEnd.toISOString().slice(0, 10)}`;
  const sentimentNote = s.sentiment && s.sentiment !== "routine" ? ` (${s.sentiment})` : "";
  const content = `${s.granularity} summary (${period})${sentimentNote}: ${s.summary}`;
  return {
    id: s.id,
    type: "summary",
    content,
    sourceChannel: channelId,
    sourceDate: s.periodEnd,
    confidence: 0.9,
    pathsMatched: ["summary"],
  };
}
