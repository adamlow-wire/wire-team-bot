/**
 * Structured retrieval path — SQL queries on decisions and actions.
 * Channel-scoped. Filters by time range, entities (text match on summary),
 * and status. For accountability intent, filters to open/in_progress actions.
 */

import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { ActionRepository } from "../../domain/repositories/ActionRepository";
import type { RetrievalResult, RetrievalScope } from "../../application/ports/RetrievalPort";
import type { QueryPlan } from "../../application/ports/QueryAnalysisPort";
import type { Decision } from "../../domain/entities/Decision";
import type { Action } from "../../domain/entities/Action";
import { fromChannelId } from "../wire/channelId";

const MAX_RESULTS = 20;

export class StructuredRetrievalPath {
  constructor(
    private readonly decisionRepo: DecisionRepository,
    private readonly actionRepo: ActionRepository,
  ) {}

  async retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]> {
    if (!scope.channelId) return [];

    const convId = fromChannelId(scope.channelId);
    const results: RetrievalResult[] = [];

    // Detect explicit DEC-/ACT- IDs in the query entities so we can look them
    // up directly by ID rather than relying on substring matching.
    const decisionIds = plan.entities.filter((e) => /^DEC-\d+$/i.test(e));
    const actionIds   = plan.entities.filter((e) => /^ACT-\d+$/i.test(e));

    // ── Decisions ─────────────────────────────────────────────────────────────
    // Fetch all active channel decisions — no entity text filter.  Using
    // entity keywords as a DB substring filter causes false negatives whenever
    // the extracted entity doesn't literally appear in the decision summary.
    // The LLM receives the full list and determines relevance itself.
    const skipDecisions = plan.intent === "accountability" && decisionIds.length === 0;
    if (!skipDecisions) {
      try {
        const decisions = await this.decisionRepo.query({
          conversationId: convId,
          statusIn: ["active"],
          limit: MAX_RESULTS,
        });

        const seen = new Set<string>();
        for (const d of decisions) {
          if (!matchesTimeRange(d.decidedAt ?? d.timestamp, plan)) continue;
          results.push(decisionToResult(d, scope.channelId));
          seen.add(d.id);
        }

        // Explicit ID lookups — include even if status is not "active"
        for (const id of decisionIds) {
          if (seen.has(id)) continue;
          try {
            const d = await this.decisionRepo.findById(id);
            if (d) results.push(decisionToResult(d, scope.channelId));
          } catch { /* non-fatal */ }
        }
      } catch {
        // non-fatal — other paths may still contribute
      }
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    try {
      const statusFilter =
        plan.intent === "accountability"
          ? (["open", "in_progress"] as Action["status"][])
          : (["open", "in_progress", "done"] as Action["status"][]);

      const actions = await this.actionRepo.query({
        conversationId: convId,
        statusIn: statusFilter,
        limit: MAX_RESULTS,
      });

      const seen = new Set<string>();
      for (const a of actions) {
        if (!matchesTimeRange(a.timestamp, plan)) continue;
        results.push(actionToResult(a, scope.channelId));
        seen.add(a.id);
      }

      // Explicit ID lookups
      for (const id of actionIds) {
        if (seen.has(id)) continue;
        try {
          const a = await this.actionRepo.findById(id);
          if (a) results.push(actionToResult(a, scope.channelId));
        } catch { /* non-fatal */ }
      }
    } catch {
      // non-fatal
    }

    return results;
  }
}

function matchesTimeRange(date: Date, plan: QueryPlan): boolean {
  if (!plan.timeRange) return true;
  const { start, end } = plan.timeRange;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function decisionToResult(d: Decision, channelId: string): RetrievalResult {
  const decidedBy = d.decidedBy?.join(", ") || d.authorName || "unknown";
  const date = d.decidedAt ?? d.timestamp;
  const content = [
    `ID: ${d.id}`,
    `Decision: ${d.summary}`,
    `Decided by: ${decidedBy}`,
    `Date: ${date.toISOString().slice(0, 10)}`,
    d.rationale ? `Rationale: ${d.rationale}` : "",
    d.tags.length > 0 ? `Tags: ${d.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    id: d.id,
    type: "decision",
    content,
    sourceChannel: channelId,
    sourceDate: date,
    confidence: d.confidence ?? 0.8,
    pathsMatched: ["structured"],
  };
}

function actionToResult(a: Action, channelId: string): RetrievalResult {
  const owner = a.assigneeName || "unassigned";
  const deadline = a.deadline ? a.deadline.toISOString().slice(0, 10) : "none";
  const content = [
    `ID: ${a.id}`,
    `Action: ${a.description}`,
    `Owner: ${owner}`,
    `Status: ${a.status}`,
    `Due: ${deadline}`,
    a.tags.length > 0 ? `Tags: ${a.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    id: a.id,
    type: "action",
    content,
    sourceChannel: channelId,
    sourceDate: a.timestamp,
    confidence: a.actionConfidence ?? 0.8,
    pathsMatched: ["structured"],
  };
}
