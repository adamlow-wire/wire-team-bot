/**
 * Unit tests for ProcessingPipeline.
 * All dependencies are mocked — no DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProcessingPipeline } from "../../src/infrastructure/pipeline/ProcessingPipeline";
import type { PipelineDeps, MessageJob } from "../../src/infrastructure/pipeline/ProcessingPipeline";
import type { ClassifyResult } from "../../src/application/ports/ClassifierPort";
import type { ExtractResult } from "../../src/application/ports/ExtractionPort";
import type { VercelAISlotFactory } from "../../src/infrastructure/llm/VercelAISlotFactory";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

import { generateText } from "ai";
const mockGenerateText = vi.mocked(generateText);

const convId = { id: "conv-1", domain: "wire.com" };
const senderId = { id: "user-1", domain: "wire.com" };

function baseJob(): MessageJob {
  return {
    messageId: "msg-1",
    channelId: "conv-1@wire.com",
    conversationId: convId,
    senderId,
    senderName: "Alice",
    text: "We decided to use Postgres",
    timestamp: new Date("2026-03-20T10:00:00Z"),
    orgId: "wire.com",
  };
}

const lowSignalResult: ClassifyResult = {
  categories: ["discussion"],
  confidence: 0.7,
  entities: [],
  is_high_signal: false,
};

const highSignalResult: ClassifyResult = {
  categories: ["decision"],
  confidence: 0.9,
  entities: ["Postgres"],
  is_high_signal: true,
};

const fullExtractResult: ExtractResult = {
  decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
  actions: [{ description: "Set up Postgres", ownerName: "Alice", confidence: 0.8, tags: [] }],
  completions: [],
  entities: [{ name: "Postgres", entityType: "service", aliases: ["PostgreSQL"] }],
  relationships: [],
  signals: [{ signalType: "update", summary: "Postgres chosen", tags: [], confidence: 0.75 }],
};

const emptyExtractResult: ExtractResult = {
  decisions: [], actions: [], completions: [], entities: [], relationships: [], signals: [],
};

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    classifier: { classify: vi.fn().mockResolvedValue(lowSignalResult) },
    extraction: { extract: vi.fn().mockResolvedValue(emptyExtractResult) },
    embeddingService: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    },
    entityRepo: {
      upsertWithDedup: vi.fn().mockResolvedValue("entity-id-1"),
      upsertRelationship: vi.fn().mockResolvedValue(undefined),
      listNames: vi.fn().mockResolvedValue([]),
    },
    embeddingRepo: {
      store: vi.fn().mockResolvedValue("embed-id-1"),
      findSimilar: vi.fn().mockResolvedValue([]),
    },
    signalRepo: { create: vi.fn().mockResolvedValue(undefined) },
    decisionRepo: {
      nextId: vi.fn().mockResolvedValue("DEC-0001"),
      create: vi.fn().mockImplementation(async (d) => d),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      query: vi.fn(),
    },
    actionRepo: {
      nextId: vi.fn().mockResolvedValue("ACT-0001"),
      create: vi.fn().mockImplementation(async (a) => a),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn(),
    },
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]) },
    slidingWindow: {
      push: vi.fn(), getWindow: vi.fn().mockReturnValue([]), flush: vi.fn(), clear: vi.fn(),
    },
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    },
    llm: {
      getModel: vi.fn().mockReturnValue("test-model"),
      getFallbackModel: vi.fn(),
      getRespondModel: vi.fn(),
      timeoutMs: 10000,
    } as unknown as VercelAISlotFactory,
    logger: {
      child: vi.fn().mockReturnThis(),
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    },
    extractConfidenceMin: 0.6,
    contradictionThreshold: 0.78,
    dedup: {
      checkCreationFlag: vi.fn().mockResolvedValue(false),
      setCreationFlag: vi.fn().mockResolvedValue(undefined),
      checkDecisionSimilarity: vi.fn().mockResolvedValue({ isDuplicate: false }),
    },
    dedupSimilarityThreshold: 0.85,
    ...overrides,
  };
}

describe("ProcessingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: contradiction check returns "no"
    mockGenerateText.mockResolvedValue({ text: "no" } as never);
  });

  describe("Low-signal path (Tier 1 only)", () => {
    it("writes a signal but does NOT call the extractor", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(lowSignalResult) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.classifier.classify).toHaveBeenCalledOnce();
      expect(deps.extraction.extract).not.toHaveBeenCalled();
      expect(deps.signalRepo.create).toHaveBeenCalledOnce();
    });

    it("maps 'question' category to question signal type", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue({ ...lowSignalResult, categories: ["question"] }) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.signalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: "question" }),
      );
    });
  });

  describe("High-signal path (Tier 1 + Tier 2)", () => {
    it("calls extractor and writes decisions, actions, entities, signals", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue(fullExtractResult) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.extraction.extract).toHaveBeenCalledOnce();
      expect(deps.decisionRepo.create).toHaveBeenCalledOnce();
      expect(deps.actionRepo.create).toHaveBeenCalledOnce();
      expect(deps.entityRepo.upsertWithDedup).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Postgres" }),
        "conv-1@wire.com",
        "wire.com",
      );
      expect(deps.signalRepo.create).toHaveBeenCalled();
    });

    it("respects extractConfidenceMin — skips low-confidence decisions", async () => {
      const lowConf: ExtractResult = {
        ...emptyExtractResult,
        decisions: [{ summary: "Maybe use Postgres", decidedBy: [], confidence: 0.4, tags: [] }],
      };
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue(lowConf) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.decisionRepo.create).not.toHaveBeenCalled();
    });

    it("writes fallback signal when extractor throws", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockRejectedValue(new Error("LLM timeout")) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.signalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: "discussion", confidence: 0.3 }),
      );
      expect(deps.decisionRepo.create).not.toHaveBeenCalled();
    });

    it("does not throw when decision repo fails", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue(fullExtractResult) },
        decisionRepo: {
          nextId: vi.fn().mockResolvedValue("DEC-0001"),
          create: vi.fn().mockRejectedValue(new Error("DB error")),
          update: vi.fn(),
          findById: vi.fn().mockResolvedValue(null),
          query: vi.fn(),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      // Should not throw
      await expect(pipeline.process(baseJob())).resolves.toBeUndefined();
    });

    it("resolves entity relationships by name", async () => {
      const withRel: ExtractResult = {
        ...emptyExtractResult,
        entities: [
          { name: "Alice", entityType: "person", aliases: [] },
          { name: "Postgres", entityType: "service", aliases: [] },
        ],
        relationships: [{
          sourceName: "Alice",
          targetName: "Postgres",
          relationship: "works_on",
          confidence: 0.8,
        }],
      };
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue(withRel) },
        entityRepo: {
          upsertWithDedup: vi.fn()
            .mockResolvedValueOnce("entity-alice")
            .mockResolvedValueOnce("entity-postgres"),
          upsertRelationship: vi.fn().mockResolvedValue(undefined),
          listNames: vi.fn().mockResolvedValue([]),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.entityRepo.upsertRelationship).toHaveBeenCalledWith(
        "entity-alice",
        "entity-postgres",
        expect.objectContaining({ relationship: "works_on" }),
      );
    });
  });

  describe("Classifier failure path", () => {
    it("writes fallback signal when classifier throws", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockRejectedValue(new Error("LLM error")) },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.signalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ confidence: 0.3 }),
      );
      expect(deps.extraction.extract).not.toHaveBeenCalled();
    });
  });

  describe("Contradiction detection", () => {
    it("sends contradiction notice when classify model returns 'yes'", async () => {
      const decisionWithId = {
        id: "DEC-0001",
        summary: "Use Postgres",
        timestamp: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
        status: "active",
        conversationId: convId,
        authorId: senderId,
        authorName: "Alice",
        rawMessageId: "msg-x",
        context: [], participants: [], supersededBy: null, supersedes: null,
        linkedIds: [], attachments: [], tags: [], updatedAt: new Date(), deleted: false, version: 1,
      };
      const existingDecision = {
        id: "DEC-0002",
        summary: "Use MySQL instead",
        timestamp: new Date(Date.now() - 90 * 60 * 1000), // 90 min ago
        status: "active",
        conversationId: convId,
        authorId: senderId,
        authorName: "Bob",
        rawMessageId: "msg-y",
        context: [], participants: [], supersededBy: null, supersedes: null,
        linkedIds: [], attachments: [], tags: [], updatedAt: new Date(), deleted: false, version: 1,
      };

      mockGenerateText.mockResolvedValue({ text: "yes" } as never);

      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
        decisionRepo: {
          nextId: vi.fn().mockResolvedValue("DEC-0001"),
          create: vi.fn().mockImplementation(async (d) => d),
          update: vi.fn(),
          findById: vi.fn()
            .mockResolvedValueOnce(decisionWithId)  // new decision
            .mockResolvedValueOnce(existingDecision),  // existing decision
          query: vi.fn(),
        },
        embeddingService: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]), embedBatch: vi.fn() },
        embeddingRepo: {
          store: vi.fn().mockResolvedValue("embed-1"),
          findSimilar: vi.fn().mockResolvedValue([{
            id: "embed-2",
            sourceId: "DEC-0002",
            sourceType: "decision",
            similarity: 0.85,  // above threshold
          }]),
        },
      });
      const pipeline = new ProcessingPipeline(deps);

      // Use a modified job with an old timestamp to pass the 30-min guard
      await pipeline.process({
        ...baseJob(),
        timestamp: new Date(Date.now() - 60 * 60 * 1000),
      });

      // Contradiction notice should have been sent
      await vi.waitFor(() => {
        expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
          convId,
          expect.stringMatching(/differs from|contradict|One notes/i),
        );
      }, { timeout: 200 });
    });

    it("does NOT send notice when classify model returns 'no'", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
        decisionRepo: {
          nextId: vi.fn().mockResolvedValue("DEC-0001"),
          create: vi.fn().mockImplementation(async (d) => d),
          update: vi.fn(),
          findById: vi.fn().mockResolvedValue({
            id: "DEC-0001",
            summary: "Use Postgres",
            timestamp: new Date(Date.now() - 60 * 60 * 1000),
            status: "active",
            conversationId: convId, authorId: senderId, authorName: "Alice",
            rawMessageId: "msg-x", context: [], participants: [], supersededBy: null,
            supersedes: null, linkedIds: [], attachments: [], tags: [],
            updatedAt: new Date(), deleted: false, version: 1,
          }),
          query: vi.fn(),
        },
        embeddingRepo: {
          store: vi.fn().mockResolvedValue("embed-1"),
          findSimilar: vi.fn().mockResolvedValue([]),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      await new Promise((r) => setTimeout(r, 50));
      expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    });
  });

  describe("Deduplication — creation flag", () => {
    it("skips decision when creation flag is set for decisions", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
        dedup: {
          checkCreationFlag: vi.fn().mockImplementation((_ch, _id, kind) =>
            Promise.resolve(kind === "decision"),
          ),
          setCreationFlag: vi.fn().mockResolvedValue(undefined),
          checkDecisionSimilarity: vi.fn().mockResolvedValue({ isDuplicate: false }),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.decisionRepo.create).not.toHaveBeenCalled();
      expect(deps.dedup.setCreationFlag).not.toHaveBeenCalled();
    });

    it("skips action when creation flag is set for actions", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          actions: [{ description: "Set up Postgres", ownerName: "Alice", confidence: 0.8, tags: [] }],
        })},
        dedup: {
          checkCreationFlag: vi.fn().mockImplementation((_ch, _id, kind) =>
            Promise.resolve(kind === "action"),
          ),
          setCreationFlag: vi.fn().mockResolvedValue(undefined),
          checkDecisionSimilarity: vi.fn().mockResolvedValue({ isDuplicate: false }),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.actionRepo.create).not.toHaveBeenCalled();
    });

    it("sets creation flag after successful decision write", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.decisionRepo.create).toHaveBeenCalledOnce();
      expect(deps.dedup.setCreationFlag).toHaveBeenCalledWith(
        baseJob().channelId,
        baseJob().messageId,
        "decision",
      );
    });
  });

  describe("Deduplication — similarity check", () => {
    it("skips decision when similarity check returns isDuplicate:true", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
        dedup: {
          checkCreationFlag: vi.fn().mockResolvedValue(false),
          setCreationFlag: vi.fn().mockResolvedValue(undefined),
          checkDecisionSimilarity: vi.fn().mockResolvedValue({ isDuplicate: true, existingId: "DEC-0099", reason: "similarity" }),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.decisionRepo.create).not.toHaveBeenCalled();
      expect(deps.dedup.setCreationFlag).not.toHaveBeenCalled();
    });

    it("proceeds with creation when similarity check returns isDuplicate:false", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
      });
      const pipeline = new ProcessingPipeline(deps);
      await pipeline.process(baseJob());

      expect(deps.decisionRepo.create).toHaveBeenCalledOnce();
    });
  });

  describe("Deduplication — unique index violation (P2002)", () => {
    const p2002 = new PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.x",
    });

    it("does not throw when decision create raises P2002", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          decisions: [{ summary: "Use Postgres", decidedBy: ["Alice"], confidence: 0.85, tags: [] }],
        })},
        decisionRepo: {
          nextId: vi.fn().mockResolvedValue("DEC-0001"),
          create: vi.fn().mockRejectedValue(p2002),
          update: vi.fn(),
          findById: vi.fn().mockResolvedValue(null),
          query: vi.fn(),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await expect(pipeline.process(baseJob())).resolves.toBeUndefined();
      expect(deps.dedup.setCreationFlag).not.toHaveBeenCalled();
    });

    it("does not throw when action create raises P2002", async () => {
      const deps = makeDeps({
        classifier: { classify: vi.fn().mockResolvedValue(highSignalResult) },
        extraction: { extract: vi.fn().mockResolvedValue({
          ...emptyExtractResult,
          actions: [{ description: "Set up Postgres", ownerName: "Alice", confidence: 0.8, tags: [] }],
        })},
        actionRepo: {
          nextId: vi.fn().mockResolvedValue("ACT-0001"),
          create: vi.fn().mockRejectedValue(p2002),
          update: vi.fn(),
          findById: vi.fn(),
          query: vi.fn(),
        },
      });
      const pipeline = new ProcessingPipeline(deps);
      await expect(pipeline.process(baseJob())).resolves.toBeUndefined();
    });
  });
});
