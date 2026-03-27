import type { Redis } from "ioredis";
import type { EmbeddingRepository } from "../../domain/repositories/EmbeddingRepository";
import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { QualifiedId } from "../../domain/ids/QualifiedId";

export type EntityKind = "decision" | "action";

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingId?: string;
  reason?: "creation_flag" | "content_hash" | "similarity";
}

export interface DeduplicationService {
  /**
   * Returns true if a creation flag is already set for this message+kind in this channel.
   * A flag means another code path (e.g. a tool call) already created the entity.
   */
  checkCreationFlag(channelId: string, rawMessageId: string, kind: EntityKind): Promise<boolean>;

  /**
   * Set the creation flag after a successful write. TTL is flagTtlSeconds (default 30 min).
   * Call this immediately after the DB write succeeds so any concurrent pipeline run sees it.
   */
  setCreationFlag(channelId: string, rawMessageId: string, kind: EntityKind): Promise<void>;

  /**
   * For decisions: check embedding cosine similarity against existing active decisions
   * in the same channel within the last 24 hours.
   * Returns isDuplicate:true if any candidate has similarity >= threshold.
   */
  checkDecisionSimilarity(
    channelId: string,
    conversationId: QualifiedId,
    embedding: number[],
    threshold: number,
  ): Promise<DuplicateCheckResult>;
}

export class RedisEmbeddingDeduplicationService implements DeduplicationService {
  private static readonly WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly redis: Redis,
    private readonly embeddingRepo: EmbeddingRepository,
    private readonly decisionRepo: DecisionRepository,
    private readonly flagTtlSeconds: number = 1800,
  ) {}

  private flagKey(channelId: string, rawMessageId: string, kind: EntityKind): string {
    return `jeeves:created:${kind}:${channelId}:${rawMessageId}`;
  }

  async checkCreationFlag(channelId: string, rawMessageId: string, kind: EntityKind): Promise<boolean> {
    const exists = await this.redis.exists(this.flagKey(channelId, rawMessageId, kind));
    return exists === 1;
  }

  async setCreationFlag(channelId: string, rawMessageId: string, kind: EntityKind): Promise<void> {
    await this.redis.set(
      this.flagKey(channelId, rawMessageId, kind),
      "1",
      "EX",
      this.flagTtlSeconds,
    );
  }

  async checkDecisionSimilarity(
    channelId: string,
    conversationId: QualifiedId,
    embedding: number[],
    threshold: number,
  ): Promise<DuplicateCheckResult> {
    const similar = await this.embeddingRepo.findSimilar(channelId, embedding, 10, "decision");
    const cutoff = Date.now() - RedisEmbeddingDeduplicationService.WINDOW_MS;

    for (const candidate of similar) {
      if (candidate.similarity < threshold) continue;
      if (!candidate.sourceId) continue;

      const decision = await this.decisionRepo.findById(candidate.sourceId);
      if (!decision) continue;
      if (decision.deleted || decision.status !== "active") continue;
      if (decision.timestamp.getTime() < cutoff) continue;
      if (decision.conversationId.id !== conversationId.id) continue;

      return { isDuplicate: true, existingId: decision.id, reason: "similarity" };
    }

    return { isDuplicate: false };
  }
}
