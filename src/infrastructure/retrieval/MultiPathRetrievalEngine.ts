/**
 * MultiPathRetrievalEngine — orchestrates StructuredRetrievalPath, SemanticRetrievalPath,
 * and GraphRetrievalPath. Merges results using weighted Reciprocal Rank Fusion (RRF)
 * with a 1.5× boost for results found by ≥2 paths, then caps output to a token budget.
 *
 * Spec §10 merge algorithm:
 * 1. Deduplicate — same id from multiple paths → one entry
 * 2. Multi-path boost — found by ≥2 paths → 1.5× multiplier
 * 3. Recency weighting — more recent = higher
 * 4. Confidence weighting — extraction confidence > 0.8 outranks lower
 * 5. Token budget — cap at 6000–8000 tokens for generation
 */

import type { RetrievalPort, RetrievalResult, RetrievalScope } from "../../application/ports/RetrievalPort";
import type { QueryPlan } from "../../application/ports/QueryAnalysisPort";
import type { StructuredRetrievalPath } from "./StructuredRetrievalPath";
import type { SemanticRetrievalPath } from "./SemanticRetrievalPath";
import type { GraphRetrievalPath } from "./GraphRetrievalPath";
import type { SummaryRetrievalPath } from "./SummaryRetrievalPath";
import type { Logger } from "../../application/ports/Logger";

/** k constant for RRF scoring: score = 1 / (k + rank) */
const RRF_K = 60;
/** Multi-path boost multiplier when result appears in ≥2 paths. */
const MULTI_PATH_BOOST = 1.5;
/** Approximate tokens per character (rough estimate for budget calculation). */
const CHARS_PER_TOKEN = 4;
/** Target token budget for all context passed to the generation call. */
const TOKEN_BUDGET = 7_000;
/** Recency half-life in milliseconds (30 days). */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Intents that automatically include the summary path even if not in the plan. */
const SUMMARY_AUTO_INTENTS = new Set(["temporal_context", "institutional"]);

export class MultiPathRetrievalEngine implements RetrievalPort {
  constructor(
    private readonly structured: StructuredRetrievalPath,
    private readonly semantic: SemanticRetrievalPath,
    private readonly graph: GraphRetrievalPath,
    private readonly summary: SummaryRetrievalPath,
    private readonly logger: Logger,
  ) {}

  async retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]> {
    // Determine which paths to run.
    // Summary path runs when explicitly requested OR for temporal/institutional intents.
    const requestedPaths = new Set(plan.paths.map((p) => p.path));
    const runSummary =
      requestedPaths.has("summary") || SUMMARY_AUTO_INTENTS.has(plan.intent);

    const [structuredResults, semanticResults, graphResults, summaryResults] =
      await Promise.allSettled([
        requestedPaths.has("structured") ? this.structured.retrieve(plan, scope) : Promise.resolve([]),
        requestedPaths.has("semantic") ? this.semantic.retrieve(plan, scope) : Promise.resolve([]),
        requestedPaths.has("graph") ? this.graph.retrieve(plan, scope) : Promise.resolve([]),
        runSummary ? this.summary.retrieve(plan, scope) : Promise.resolve([]),
      ]);

    const pathOutputs: Array<{ path: string; results: RetrievalResult[] }> = [
      {
        path: "structured",
        results: structuredResults.status === "fulfilled" ? structuredResults.value : [],
      },
      {
        path: "semantic",
        results: semanticResults.status === "fulfilled" ? semanticResults.value : [],
      },
      {
        path: "graph",
        results: graphResults.status === "fulfilled" ? graphResults.value : [],
      },
      {
        path: "summary",
        results: summaryResults.status === "fulfilled" ? summaryResults.value : [],
      },
    ];

    if (structuredResults.status === "rejected") {
      this.logger.warn("MultiPathRetrievalEngine: structured path failed", {
        err: String(structuredResults.reason),
      });
    }
    if (semanticResults.status === "rejected") {
      this.logger.warn("MultiPathRetrievalEngine: semantic path failed", {
        err: String(semanticResults.reason),
      });
    }
    if (graphResults.status === "rejected") {
      this.logger.warn("MultiPathRetrievalEngine: graph path failed", {
        err: String(graphResults.reason),
      });
    }
    if (summaryResults.status === "rejected") {
      this.logger.warn("MultiPathRetrievalEngine: summary path failed", {
        err: String(summaryResults.reason),
      });
    }

    return this.merge(pathOutputs, plan);
  }

  private merge(
    pathOutputs: Array<{ path: string; results: RetrievalResult[] }>,
    plan: QueryPlan,
  ): RetrievalResult[] {
    // Step 1: Collect all results, tracking which paths found each id
    const byId = new Map<string, RetrievalResult>();

    for (const { path, results } of pathOutputs) {
      for (const result of results) {
        const existing = byId.get(result.id);
        if (existing) {
          // Merge paths matched
          if (!existing.pathsMatched.includes(path)) {
            existing.pathsMatched.push(path);
          }
          // Keep highest confidence
          if (result.confidence > existing.confidence) {
            existing.confidence = result.confidence;
          }
        } else {
          byId.set(result.id, { ...result, pathsMatched: [path] });
        }
      }
    }

    if (byId.size === 0) return [];

    // Step 2: RRF scoring with per-path ranks
    const rrfScores = new Map<string, number>();
    for (const id of byId.keys()) {
      rrfScores.set(id, 0);
    }

    for (const { results } of pathOutputs) {
      results.forEach((result, rank) => {
        const current = rrfScores.get(result.id) ?? 0;
        rrfScores.set(result.id, current + 1 / (RRF_K + rank + 1));
      });
    }

    const now = Date.now();

    // Step 3: Final scoring = RRF × multi-path-boost × recency × confidence
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, result] of byId.entries()) {
      let score = rrfScores.get(id) ?? 0;

      // Multi-path boost
      if (result.pathsMatched.length >= 2) {
        score *= MULTI_PATH_BOOST;
      }

      // Recency weighting: exponential decay
      const ageMs = now - result.sourceDate.getTime();
      const recencyFactor = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
      score *= 0.5 + 0.5 * recencyFactor;

      // Confidence weighting (0.8 threshold)
      if (result.confidence > 0.8) {
        score *= 1.2;
      } else if (result.confidence < 0.5) {
        score *= 0.8;
      }

      // Intent-specific boosts
      if (plan.intent === "accountability" && result.type === "action") {
        score *= 1.3;
      } else if (
        (plan.intent === "factual_recall" || plan.intent === "institutional") &&
        result.type === "decision"
      ) {
        score *= 1.3;
      } else if (plan.intent === "dependency" && result.type === "entity") {
        score *= 1.3;
      }

      scored.push({ id, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Step 5: Token budget enforcement
    const output: RetrievalResult[] = [];
    let tokenCount = 0;

    for (const { id } of scored) {
      const result = byId.get(id)!;
      const estimatedTokens = Math.ceil(result.content.length / CHARS_PER_TOKEN);
      if (tokenCount + estimatedTokens > TOKEN_BUDGET) break;
      output.push(result);
      tokenCount += estimatedTokens;
    }

    return output;
  }
}
