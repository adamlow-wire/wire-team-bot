import { describe, it, expect, vi } from "vitest";
import { RevokeDecision } from "../../src/application/usecases/decisions/RevokeDecision";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Decision } from "../../src/domain/entities/Decision";

describe("RevokeDecision", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const actorId: QualifiedId = { id: "user-2", domain: "wire.com" };

  const decision: Decision = {
    id: "DEC-0001",
    summary: "Use MySQL",
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
  };

  it("sets status to revoked and sends reply", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockImplementation(async (d) => d),
      findById: vi.fn().mockResolvedValue(decision),
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
    const useCase = new RevokeDecision(decisionsRepo, wireOutbound, auditLog);

    const result = await useCase.execute({
      decisionId: "DEC-0001",
      conversationId: convId,
      actorId,
      replyToMessageId: "msg-1",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("revoked");
    expect(decisionsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "DEC-0001", status: "revoked" }),
    );
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorId }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("DEC-0001");
    expect(sent[0]).toContain("revoked");
  });

  it("includes reason in reply when provided", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockImplementation(async (d) => d),
      findById: vi.fn().mockResolvedValue(decision),
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
    const useCase = new RevokeDecision(decisionsRepo, wireOutbound, auditLog);

    await useCase.execute({
      decisionId: "DEC-0001",
      conversationId: convId,
      actorId,
      reason: "Superseded by DEC-0002",
    });

    expect(sent[0]).toContain("Reason: Superseded by DEC-0002");
  });

  it("returns null when decision not found", async () => {
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
    const useCase = new RevokeDecision(decisionsRepo, wireOutbound, auditLog);

    const result = await useCase.execute({
      decisionId: "DEC-9999",
      conversationId: convId,
      actorId,
    });

    expect(result).toBeNull();
    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});
