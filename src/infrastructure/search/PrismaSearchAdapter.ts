import type { SearchService, KnowledgeSearchHit, KnowledgeSearchInput } from "../../domain/services/SearchService";
import type { KnowledgeRepository } from "../../domain/repositories/KnowledgeRepository";
import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { KnowledgeEntry } from "../../domain/entities/KnowledgeEntry";

// RRF constant k=60 (Cormack et al., 2009). Higher k reduces the weight of top-ranked
// documents; 60 is the well-established default for most retrieval scenarios.
const RRF_K = 60;

/**
 * Hybrid knowledge search: keyword scoring combined with pgvector cosine-similarity
 * via Reciprocal Rank Fusion (RRF).  When no EmbeddingService is provided (or the
 * embedding call fails), falls back gracefully to keyword-only search.
 */
export class PrismaSearchAdapter implements SearchService {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly embeddingService?: EmbeddingService,
  ) {}

  async searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchHit[]> {
    const limit = input.limit ?? 10;
    const pool = limit * 2;

    // ── Keyword search ────────────────────────────────────────────────────────
    const keywordEntries = await this.knowledge.query({
      searchText: input.query,
      limit: pool,
    });

    let keywordFiltered = keywordEntries;
    if (input.conversationIds && input.conversationIds.length > 0) {
      const keys = new Set(input.conversationIds.map((c) => `${c.id}@${c.domain}`));
      keywordFiltered = keywordEntries.filter(
        (e) => keys.has(`${e.conversationId.id}@${e.conversationId.domain}`),
      );
    }

    // Score keyword hits and assign ranks
    const keywordScored = this.scoreKeyword(keywordFiltered, input.query);
    const keywordRankMap = new Map<string, number>();
    keywordScored.forEach(({ entry }, rank) => keywordRankMap.set(entry.id, rank));

    // ── Semantic search (optional) ────────────────────────────────────────────
    const semanticRankMap = new Map<string, number>();
    const semanticOnlyIds: string[] = [];

    if (this.embeddingService && input.query && input.query.length > 0) {
      const queryEmbedding = await this.embeddingService.embed(input.query);
      if (queryEmbedding && input.conversationIds && input.conversationIds.length > 0) {
        const semanticHits = await this.knowledge.findByEmbedding(
          queryEmbedding,
          input.conversationIds,
          pool,
        );
        semanticHits.forEach(({ id }, rank) => {
          semanticRankMap.set(id, rank);
          if (!keywordRankMap.has(id)) semanticOnlyIds.push(id);
        });
      }
    }

    // ── Fetch entries found only by semantic search ───────────────────────────
    const entryMap = new Map<string, KnowledgeEntry>();
    for (const { entry } of keywordScored) entryMap.set(entry.id, entry);

    if (semanticOnlyIds.length > 0) {
      const extra = await this.knowledge.findByIds(semanticOnlyIds);
      for (const e of extra) entryMap.set(e.id, e);
    }

    // ── RRF merge and final ranking ───────────────────────────────────────────
    const allIds = [...entryMap.keys()];
    const rrfScores = allIds.map((id) => {
      let score = 0;
      const kwRank = keywordRankMap.get(id);
      const semRank = semanticRankMap.get(id);
      if (kwRank !== undefined) score += 1 / (RRF_K + kwRank);
      if (semRank !== undefined) score += 1 / (RRF_K + semRank);
      return { id, score };
    });

    rrfScores.sort((a, b) => b.score - a.score);

    return rrfScores.slice(0, limit).map(({ id, score }) => {
      const entry = entryMap.get(id)!;
      return {
        id: entry.id,
        summary: entry.summary,
        detail: entry.detail,
        authorName: entry.authorName,
        conversationId: entry.conversationId,
        confidence: entry.confidence,
        updatedAt: entry.updatedAt,
        retrievalCount: entry.retrievalCount,
        score,
      };
    });
  }

  private scoreKeyword(
    entries: KnowledgeEntry[],
    query: string,
  ): Array<{ entry: KnowledgeEntry; score: number }> {
    const terms =
      query && query.length > 0
        ? query
            .split(/\s+/)
            .map((t) => t.replace(/[?!.,;:'"]/g, "").toLowerCase())
            .filter((t) => t.length > 2)
        : [];

    const scored = entries.map((entry) => {
      let score = 0.5;
      if (terms.length > 0) {
        const summaryLower = entry.summary.toLowerCase();
        const detailLower = entry.detail.toLowerCase();
        const summaryHits = terms.filter((t) => summaryLower.includes(t)).length;
        const detailHits = terms.filter((t) => detailLower.includes(t)).length;
        score += (summaryHits / terms.length) * 0.3;
        score += (detailHits / terms.length) * 0.2;
      }
      const recency = (Date.now() - entry.updatedAt.getTime()) / (30 * 24 * 60 * 60 * 1000);
      score += Math.max(0, 0.2 - recency * 0.1);
      if (entry.confidence === "high") score += 0.15;
      else if (entry.confidence === "medium") score += 0.08;
      score += Math.min(0.1, entry.retrievalCount * 0.01);
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
