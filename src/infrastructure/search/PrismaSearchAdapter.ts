import type { SearchService, KnowledgeSearchHit, KnowledgeSearchInput } from "../../domain/services/SearchService";
import type { KnowledgeRepository } from "../../domain/repositories/KnowledgeRepository";

/**
 * Keyword-based search over knowledge entries. Uses repository query with searchText.
 * Ranking: simple relevance (match) + recency + confidence weight. Phase 4 can add pgvector.
 */
export class PrismaSearchAdapter implements SearchService {
  constructor(private readonly knowledge: KnowledgeRepository) {}

  async searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchHit[]> {
    const limit = input.limit ?? 10;
    const entries = await this.knowledge.query({
      searchText: input.query,
      limit: limit * 2,
    });

    let filtered = entries;
    if (input.conversationIds && input.conversationIds.length > 0) {
      const keys = new Set(
        input.conversationIds.map((c) => `${c.id}@${c.domain}`),
      );
      filtered = entries.filter(
        (e) => keys.has(`${e.conversationId.id}@${e.conversationId.domain}`),
      );
    }

    const scored: { entry: (typeof filtered)[0]; score: number }[] = filtered.map(
      (entry) => {
        let score = 0.5;
        if (input.query && input.query.length > 0) {
          const terms = input.query
            .split(/\s+/)
            .map((t) => t.replace(/[?!.,;:'"]/g, "").toLowerCase())
            .filter((t) => t.length > 2);
          if (terms.length > 0) {
            const summaryLower = entry.summary.toLowerCase();
            const detailLower = entry.detail.toLowerCase();
            const summaryHits = terms.filter((t) => summaryLower.includes(t)).length;
            const detailHits = terms.filter((t) => detailLower.includes(t)).length;
            // Score proportionally: full term overlap in summary = +0.3, detail = +0.2
            score += (summaryHits / terms.length) * 0.3;
            score += (detailHits / terms.length) * 0.2;
          }
        }
        const recency = (Date.now() - entry.updatedAt.getTime()) / (30 * 24 * 60 * 60 * 1000);
        score += Math.max(0, 0.2 - recency * 0.1);
        if (entry.confidence === "high") score += 0.15;
        else if (entry.confidence === "medium") score += 0.08;
        score += Math.min(0.1, entry.retrievalCount * 0.01);
        return { entry, score };
      },
    );
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ entry, score }) => ({
      id: entry.id,
      summary: entry.summary,
      detail: entry.detail,
      authorName: entry.authorName,
      conversationId: entry.conversationId,
      confidence: entry.confidence,
      updatedAt: entry.updatedAt,
      retrievalCount: entry.retrievalCount,
      score,
    }));
  }
}
