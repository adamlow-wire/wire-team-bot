import { describe, it, expect, vi } from "vitest";
import { ListMyActions } from "../../src/application/usecases/actions/ListMyActions";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

describe("ListMyActions", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const assigneeId: QualifiedId = { id: "user-1", domain: "wire.com" };

  function stubWireOutbound(sent: string[]): WireOutboundPort {
    return {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("lists assignee actions and sends reply sorted by deadline", async () => {
    const actions: Action[] = [
      {
        id: "ACT-0001",
        description: "Deploy",
        rawMessageId: "",
        assigneeId,
        assigneeName: "Alice",
        creatorId: assigneeId,
        authorName: "Alice",
        conversationId: convId,
        deadline: new Date("2025-04-01"),
        status: "open",
        linkedIds: [],
        reminderAt: [],
        completionNote: null,
        timestamp: new Date(),
        updatedAt: new Date(),
        tags: [],
        deleted: false,
        version: 1,
      },
    ];
    const actionsRepo: ActionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn().mockResolvedValue(actions),
    };
    const sent: string[] = [];
    const useCase = new ListMyActions(actionsRepo, stubWireOutbound(sent));

    const result = await useCase.execute({
      conversationId: convId,
      assigneeId,
      replyToMessageId: "msg-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ACT-0001");
    expect(actionsRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: convId,
        assigneeId,
        statusIn: expect.arrayContaining(["open", "in_progress", "overdue"]),
        limit: 20,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ACT-0001");
    expect(sent[0]).toContain("Deploy");
  });

  it("sends message when no open actions", async () => {
    const actionsRepo: ActionRepository = {
      nextId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
    };
    const sent: string[] = [];
    const useCase = new ListMyActions(actionsRepo, stubWireOutbound(sent));

    await useCase.execute({ conversationId: convId, assigneeId });

    expect(sent[0]).toContain("No open actions");
  });
});
