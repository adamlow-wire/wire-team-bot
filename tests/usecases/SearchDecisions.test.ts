import { describe, it, expect, vi } from "vitest";
import { SearchDecisions } from "../../src/application/usecases/decisions/SearchDecisions";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Decision } from "../../src/domain/entities/Decision";

describe("SearchDecisions", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

  function stubWireOutbound(sent: { text: string }[]): WireOutboundPort {
    return {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => {
        sent.push(text);
      }),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("queries by search text and sends reply with matches", async () => {
    const decisions: Decision[] = [
      {
        id: "DEC-0001",
        summary: "Use Prisma for persistence",
        rawMessage: "",
        rawMessageId: "",
        context: [],
        authorId: convId,
        authorName: "",
        participants: [],
        conversationId: convId,
        status: "active",
        linkedIds: [],
        attachments: [],
        tags: [],
        timestamp: new Date(),
        updatedAt: new Date(),
        deleted: false,
        version: 1,
      },
    ];
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn().mockResolvedValue(decisions),
    };
    const sent: string[] = [];
    const useCase = new SearchDecisions(decisionsRepo, stubWireOutbound(sent));

    const result = await useCase.execute({
      conversationId: convId,
      searchText: "Prisma",
      replyToMessageId: "msg-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("DEC-0001");
    expect(decisionsRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: convId,
        searchText: "Prisma",
        statusIn: ["active"],
        limit: 10,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("DEC-0001");
    expect(sent[0]).toContain("Prisma");
  });

  it("sends 'No matching decisions' when none found", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
    };
    const sent: string[] = [];
    const useCase = new SearchDecisions(decisionsRepo, stubWireOutbound(sent));

    await useCase.execute({
      conversationId: convId,
      searchText: "nonexistent",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("No matching decisions.");
  });
});
