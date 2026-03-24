import { describe, it, expect, vi } from "vitest";
import { SupersedeDecision } from "../../src/application/usecases/decisions/SupersedeDecision";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Decision } from "../../src/domain/entities/Decision";

describe("SupersedeDecision", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const authorId: QualifiedId = { id: "user-1", domain: "wire.com" };

  const oldDecision: Decision = {
    id: "DEC-0001",
    summary: "Use MySQL",
    rawMessageId: "",
    context: [],
    authorId,
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
  };

  it("creates new decision, marks old superseded, sends reply", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn().mockResolvedValue("DEC-0002"),
      create: vi.fn().mockImplementation(async (d) => d),
      update: vi.fn().mockImplementation(async (d) => d),
      findById: vi.fn().mockResolvedValue(oldDecision),
      query: vi.fn(),
    };
    const sent: string[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new SupersedeDecision(decisionsRepo, wireOutbound, auditLog);

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "Alice",
      rawMessageId: "msg-1",
      newSummary: "Use Prisma",
      supersedesDecisionId: "DEC-0001",
      replyToMessageId: "msg-1",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("DEC-0002");
    expect(result!.supersedes).toBe("DEC-0001");
    expect(result!.authorName).toBe("Alice");
    expect(decisionsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "DEC-0001", status: "superseded", supersededBy: "DEC-0002" }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("DEC-0002");
    expect(sent[0]).toContain("supersedes DEC-0001");
  });

  it("returns null when old decision not found", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      query: vi.fn(),
    };
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn(),
      sendCompositePrompt: vi.fn(),
      sendReaction: vi.fn(),
      sendFile: vi.fn(),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new SupersedeDecision(decisionsRepo, wireOutbound, auditLog);

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "",
      rawMessageId: "msg-1",
      newSummary: "New",
      supersedesDecisionId: "DEC-9999",
    });

    expect(result).toBeNull();
    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});
