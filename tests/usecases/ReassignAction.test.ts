import { describe, it, expect, vi } from "vitest";
import { ReassignAction } from "../../src/application/usecases/actions/ReassignAction";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { UserResolutionService } from "../../src/domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

describe("ReassignAction", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const actorId: QualifiedId = { id: "user-1", domain: "wire.com" };
  const newUserId: QualifiedId = { id: "user-2", domain: "wire.com" };

  const action: Action = {
    id: "ACT-0001",
    description: "Deploy",
    rawMessage: "",
    rawMessageId: "",
    assigneeId: actorId,
    assigneeName: "Alice",
    creatorId: actorId,
    authorName: "Alice",
    conversationId: convId,
    deadline: null,
    status: "open",
    linkedIds: [],
    reminderAt: [],
    completionNote: null,
    timestamp: new Date(),
    updatedAt: new Date(),
    tags: [],
    deleted: false,
    version: 1,
  };

  it("reassigns action and sends confirmation", async () => {
    const actionsRepo: ActionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockImplementation(async (a) => a),
      findById: vi.fn().mockResolvedValue(action),
      query: vi.fn(),
    };
    const userResolution: UserResolutionService = {
      resolveByHandleOrName: vi.fn().mockResolvedValue({ userId: newUserId, ambiguous: false }),
    };
    const sent: string[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ReassignAction(actionsRepo, userResolution, wireOutbound, auditLog);

    const result = await useCase.execute({
      actionId: "ACT-0001",
      conversationId: convId,
      newAssigneeReference: "Bob",
      actorId,
      replyToMessageId: "msg-1",
    });

    expect(result).not.toBeNull();
    expect(result!.assigneeId).toEqual(newUserId);
    expect(actionsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ACT-0001", assigneeId: newUserId }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("reassigned");
    expect(sent[0]).toContain("Alice");
    expect(sent[0]).toContain("Bob");
  });

  it("sends error when assignee ambiguous", async () => {
    const actionsRepo: ActionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(action),
      query: vi.fn(),
    };
    const userResolution: UserResolutionService = {
      resolveByHandleOrName: vi.fn().mockResolvedValue({ userId: null, ambiguous: true }),
    };
    const sent: string[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ReassignAction(actionsRepo, userResolution, wireOutbound, auditLog);

    const result = await useCase.execute({
      actionId: "ACT-0001",
      conversationId: convId,
      newAssigneeReference: "Bob",
      actorId,
    });

    expect(result).toBeNull();
    expect(sent[0]).toContain("Multiple users match");
    expect(actionsRepo.update).not.toHaveBeenCalled();
  });

  it("returns null when action not found", async () => {
    const actionsRepo: ActionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      query: vi.fn(),
    };
    const userResolution: UserResolutionService = {
      resolveByHandleOrName: vi.fn(),
    };
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn(),
      sendCompositePrompt: vi.fn(),
      sendReaction: vi.fn(),
      sendFile: vi.fn(),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new ReassignAction(actionsRepo, userResolution, wireOutbound, auditLog);

    const result = await useCase.execute({
      actionId: "ACT-9999",
      conversationId: convId,
      newAssigneeReference: "Bob",
      actorId,
    });

    expect(result).toBeNull();
    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});
