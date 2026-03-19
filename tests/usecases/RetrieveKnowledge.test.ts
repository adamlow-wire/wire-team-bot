import { describe, it, expect, vi } from "vitest";
import { RetrieveKnowledge } from "../../src/application/usecases/knowledge/RetrieveKnowledge";
import type { KnowledgeRepository } from "../../src/domain/repositories/KnowledgeRepository";
import type { SearchService } from "../../src/domain/services/SearchService";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

describe("RetrieveKnowledge", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

  it("replies with top results and increments retrieval count", async () => {
    const hits = [
      {
        id: "KB-0001",
        summary: "Schwarz API rate limit",
        detail: "500 requests per minute",
        authorName: "Alice",
        conversationId: convId,
        confidence: "high",
        updatedAt: new Date(),
        retrievalCount: 0,
        score: 0.9,
      },
    ];
    const searchService: SearchService = {
      searchKnowledge: vi.fn().mockResolvedValue(hits),
    };
    const knowledgeRepo: KnowledgeRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      incrementRetrievalCount: vi.fn().mockResolvedValue(undefined),
      updateEmbedding: vi.fn().mockResolvedValue(undefined),
      findMissingEmbeddings: vi.fn().mockResolvedValue([]),
      findByEmbedding: vi.fn().mockResolvedValue([]),
    };
    const sent: string[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new RetrieveKnowledge(searchService, knowledgeRepo, wireOutbound);

    await useCase.execute({
      conversationId: convId,
      query: "Schwarz rate limit",
      replyToMessageId: "msg-1",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("KB-0001");
    expect(sent[0]).toContain("500 requests");
    expect(knowledgeRepo.incrementRetrievalCount).toHaveBeenCalledWith("KB-0001");
  });

  it("sends fallback message when no results", async () => {
    const searchService: SearchService = {
      searchKnowledge: vi.fn().mockResolvedValue([]),
    };
    const knowledgeRepo: KnowledgeRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      incrementRetrievalCount: vi.fn(),
      updateEmbedding: vi.fn().mockResolvedValue(undefined),
      findMissingEmbeddings: vi.fn().mockResolvedValue([]),
      findByEmbedding: vi.fn().mockResolvedValue([]),
    };
    const sent: string[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const useCase = new RetrieveKnowledge(searchService, knowledgeRepo, wireOutbound);

    await useCase.execute({ conversationId: convId, query: "nonexistent" });

    expect(sent[0]).toContain("I don't have any knowledge stored");
    expect(knowledgeRepo.incrementRetrievalCount).not.toHaveBeenCalled();
  });
});
