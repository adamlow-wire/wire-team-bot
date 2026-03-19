import { describe, it, expect, vi } from "vitest";
import { StoreKnowledge } from "../../src/application/usecases/knowledge/StoreKnowledge";
import type { KnowledgeRepository } from "../../src/domain/repositories/KnowledgeRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };

describe("StoreKnowledge", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const authorId: QualifiedId = { id: "user-1", domain: "wire.com" };

  it("creates knowledge entry and sends confirmation with reaction", async () => {
    const knowledgeRepo: KnowledgeRepository = {
      nextId: vi.fn().mockResolvedValue("KB-0001"),
      create: vi.fn().mockImplementation(async (e) => e),
      update: vi.fn(),
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn(),
      incrementRetrievalCount: vi.fn().mockResolvedValue(undefined),
      updateEmbedding: vi.fn().mockResolvedValue(undefined),
      findMissingEmbeddings: vi.fn().mockResolvedValue([]),
      findByEmbedding: vi.fn().mockResolvedValue([]),
    };
    const sent: { text: string }[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push({ text })),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new StoreKnowledge(knowledgeRepo, wireOutbound, auditLog, mockLogger);

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "Alice",
      rawMessageId: "msg-1",
      rawMessage: "knowledge: Schwarz API rate limit is 500/min",
      summary: "Schwarz API rate limit is 500/min",
      detail: "Schwarz API rate limit is 500/min",
    });

    expect(result.id).toBe("KB-0001");
    expect(result.summary).toBe("Schwarz API rate limit is 500/min");
    expect(result.confidence).toBe("high");
    expect(result.category).toBe("factual");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("KB-0001");
    expect(wireOutbound.sendReaction).toHaveBeenCalledWith(convId, "msg-1", "✓");
  });
});
