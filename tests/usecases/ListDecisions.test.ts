import { describe, it, expect, vi } from "vitest";
import { ListDecisions } from "../../src/application/usecases/decisions/ListDecisions";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Decision } from "../../src/domain/entities/Decision";

describe("ListDecisions", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

  function stubWireOutbound(sent: string[]): WireOutboundPort {
    return {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("lists active decisions and sends reply", async () => {
    const decisions: Decision[] = [
      {
        id: "DEC-0001",
        summary: "Use Prisma",
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
    const useCase = new ListDecisions(decisionsRepo, stubWireOutbound(sent));

    const result = await useCase.execute({ conversationId: convId, replyToMessageId: "msg-1" });

    expect(result).toHaveLength(1);
    expect(decisionsRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: convId, statusIn: ["active"], limit: 15 }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("DEC-0001");
  });

  it("sends message when no recent decisions", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
    };
    const sent: string[] = [];
    const useCase = new ListDecisions(decisionsRepo, stubWireOutbound(sent));

    await useCase.execute({ conversationId: convId });

    expect(sent[0]).toContain("No recent decisions");
  });
});
