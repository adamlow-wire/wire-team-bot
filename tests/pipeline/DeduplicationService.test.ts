import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisEmbeddingDeduplicationService } from "../../src/application/services/DeduplicationService";
import type { Redis } from "ioredis";
import type { EmbeddingRepository } from "../../src/domain/repositories/EmbeddingRepository";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";

const convId = { id: "conv-1", domain: "wire.com" };

function makeRedis(existsResult = 0) {
  return {
    exists: vi.fn().mockResolvedValue(existsResult),
    set: vi.fn().mockResolvedValue("OK"),
  } as unknown as Redis;
}

function makeEmbeddingRepo(similar: { id: string; sourceId?: string; sourceType: "decision"; similarity: number }[] = []) {
  return {
    findSimilar: vi.fn().mockResolvedValue(similar),
    store: vi.fn(),
  } as unknown as EmbeddingRepository;
}

function makeDecisionRepo(decision: unknown = null) {
  return {
    findById: vi.fn().mockResolvedValue(decision),
    findByContentHash: vi.fn(),
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    nextId: vi.fn(),
  } as unknown as DecisionRepository;
}

describe("RedisEmbeddingDeduplicationService", () => {
  describe("checkCreationFlag", () => {
    it("returns false when key does not exist", async () => {
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(0), makeEmbeddingRepo(), makeDecisionRepo());
      expect(await svc.checkCreationFlag("conv-1@wire.com", "msg-1", "decision")).toBe(false);
    });

    it("returns true when key exists", async () => {
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(1), makeEmbeddingRepo(), makeDecisionRepo());
      expect(await svc.checkCreationFlag("conv-1@wire.com", "msg-1", "decision")).toBe(true);
    });

    it("checks the correct key for decisions vs actions", async () => {
      const redis = makeRedis(0);
      const svc = new RedisEmbeddingDeduplicationService(redis, makeEmbeddingRepo(), makeDecisionRepo());
      await svc.checkCreationFlag("conv-1@wire.com", "msg-1", "decision");
      await svc.checkCreationFlag("conv-1@wire.com", "msg-1", "action");
      expect((redis.exists as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(":decision:");
      expect((redis.exists as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain(":action:");
    });
  });

  describe("setCreationFlag", () => {
    it("calls SET with correct key and TTL", async () => {
      const redis = makeRedis();
      const svc = new RedisEmbeddingDeduplicationService(redis, makeEmbeddingRepo(), makeDecisionRepo(), 900);
      await svc.setCreationFlag("conv-1@wire.com", "msg-abc", "decision");
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining("jeeves:created:decision:conv-1@wire.com:msg-abc"),
        "1",
        "EX",
        900,
      );
    });

    it("uses default TTL of 1800 seconds", async () => {
      const redis = makeRedis();
      const svc = new RedisEmbeddingDeduplicationService(redis, makeEmbeddingRepo(), makeDecisionRepo());
      await svc.setCreationFlag("ch", "msg", "action");
      expect(redis.set).toHaveBeenCalledWith(expect.any(String), "1", "EX", 1800);
    });
  });

  describe("checkDecisionSimilarity", () => {
    it("returns isDuplicate:false when no similar embeddings found", async () => {
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo([]), makeDecisionRepo());
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1, 0.2], 0.85);
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate:false when similarity below threshold", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.80 }];
      const decision = {
        id: "DEC-1", summary: "old decision", status: "active", deleted: false,
        conversationId: convId, timestamp: new Date(), // recent
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate:true when active same-channel decision matches within 24h", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.92 }];
      const decision = {
        id: "DEC-1", summary: "use postgres", status: "active", deleted: false,
        conversationId: convId,
        timestamp: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(true);
      expect(result.existingId).toBe("DEC-1");
      expect(result.reason).toBe("similarity");
    });

    it("returns isDuplicate:false when matching decision is older than 24h", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.95 }];
      const decision = {
        id: "DEC-1", status: "active", deleted: false, conversationId: convId,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate:false when matching decision is in a different channel", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.95 }];
      const decision = {
        id: "DEC-1", status: "active", deleted: false,
        conversationId: { id: "other-conv", domain: "wire.com" }, // different channel
        timestamp: new Date(Date.now() - 60 * 60 * 1000),
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate:false when matching decision is deleted", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.95 }];
      const decision = {
        id: "DEC-1", status: "active", deleted: true, // deleted
        conversationId: convId, timestamp: new Date(Date.now() - 60 * 60 * 1000),
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate:false when matching decision is not active", async () => {
      const similar = [{ id: "emb-1", sourceId: "DEC-1", sourceType: "decision" as const, similarity: 0.95 }];
      const decision = {
        id: "DEC-1", status: "superseded", deleted: false, // not active
        conversationId: convId, timestamp: new Date(Date.now() - 60 * 60 * 1000),
      };
      const svc = new RedisEmbeddingDeduplicationService(makeRedis(), makeEmbeddingRepo(similar), makeDecisionRepo(decision));
      const result = await svc.checkDecisionSimilarity("ch", convId, [0.1], 0.85);
      expect(result.isDuplicate).toBe(false);
    });
  });
});
