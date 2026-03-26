/**
 * Semantic retrieval path — pgvector HNSW cosine similarity on the embeddings table.
 * Embeds the question, finds similar stored vectors, then enriches with source record details.
 * Falls back to empty results if embedding or similarity search fails.
 */

import type { EmbeddingRepository } from "../../domain/repositories/EmbeddingRepository";
import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { ActionRepository } from "../../domain/repositories/ActionRepository";
import type { RetrievalResult, RetrievalScope } from "../../application/ports/RetrievalPort";
import type { QueryPlan } from "../../application/ports/QueryAnalysisPort";
import type { Logger } from "../../application/ports/Logger";

const MAX_SIMILAR = 10;
const MIN_SIMILARITY = 0.55;

export interface EmbeddingService {
  embed(text: string): Promise<number[] | null>;
}

export class SemanticRetrievalPath {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly embeddingRepo: EmbeddingRepository,
    private readonly decisionRepo: DecisionRepository,
    private readonly actionRepo: ActionRepository,
    private readonly logger: Logger,
  ) {}

  async retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]> {
    if (!scope.channelId) return [];

    // Build query text from question + entity hints
    const queryText =
      plan.entities.length > 0
        ? `${plan.entities.join(" ")} — retrieval query`
        : "retrieval query";

    let embedding: number[] | null;
    try {
      embedding = await this.embeddingService.embed(queryText);
    } catch (err) {
      this.logger.warn("SemanticRetrievalPath: embedding failed", { err: String(err) });
      return [];
    }
    if (!embedding) return [];

    const similar = await this.embeddingRepo.findSimilar(
      scope.channelId,
      embedding,
      MAX_SIMILAR,
    );

    const aboveThreshold = similar.filter((s) => s.similarity >= MIN_SIMILARITY);
    if (aboveThreshold.length === 0) return [];

    const results: RetrievalResult[] = [];

    for (const hit of aboveThreshold) {
      if (!hit.sourceId) continue;

      try {
        if (hit.sourceType === "decision") {
          const d = await this.decisionRepo.findById(hit.sourceId);
          if (!d || d.deleted) continue;
          const decidedBy = d.decidedBy?.join(", ") || d.authorName || "unknown";
          const date = d.decidedAt ?? d.timestamp;
          results.push({
            id: d.id,
            type: "decision",
            content: [
              `ID: ${d.id}`,
              `Decision: ${d.summary}`,
              `Decided by: ${decidedBy}`,
              `Date: ${date.toISOString().slice(0, 10)}`,
              d.rationale ? `Rationale: ${d.rationale}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
            sourceChannel: scope.channelId,
            sourceDate: date,
            confidence: hit.similarity,
            pathsMatched: ["semantic"],
          });
        } else if (hit.sourceType === "action") {
          const a = await this.actionRepo.findById(hit.sourceId);
          if (!a || a.deleted) continue;
          const owner = a.assigneeName || "unassigned";
          results.push({
            id: a.id,
            type: "action",
            content: [
              `ID: ${a.id}`,
              `Action: ${a.description}`,
              `Owner: ${owner}`,
              `Status: ${a.status}`,
              a.deadline ? `Due: ${a.deadline.toISOString().slice(0, 10)}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
            sourceChannel: scope.channelId,
            sourceDate: a.timestamp,
            confidence: hit.similarity,
            pathsMatched: ["semantic"],
          });
        }
      } catch (err) {
        this.logger.warn("SemanticRetrievalPath: source lookup failed", {
          sourceId: hit.sourceId, err: String(err),
        });
      }
    }

    return results;
  }
}
