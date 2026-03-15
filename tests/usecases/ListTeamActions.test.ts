import { describe, it, expect, vi } from "vitest";
import { ListTeamActions } from "../../src/application/usecases/actions/ListTeamActions";
import type { ActionRepository } from "../../src/domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Action } from "../../src/domain/entities/Action";

describe("ListTeamActions", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const user1: QualifiedId = { id: "user-1", domain: "wire.com" };
  const user2: QualifiedId = { id: "user-2", domain: "wire.com" };

  function stubWireOutbound(sent: string[]): WireOutboundPort {
    return {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => sent.push(text)),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("lists open actions grouped by assignee and sends reply", async () => {
    const actions: Action[] = [
      {
        id: "ACT-0001",
        description: "Deploy",
        rawMessage: "",
        rawMessageId: "",
        assigneeId: user1,
        assigneeName: "Alice",
        creatorId: user2,
        authorName: "Bob",
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
    const useCase = new ListTeamActions(actionsRepo, stubWireOutbound(sent));

    const result = await useCase.execute({
      conversationId: convId,
      replyToMessageId: "msg-1",
    });

    expect(result).toHaveLength(1);
    expect(actionsRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: convId,
        statusIn: ["open", "in_progress", "overdue"],
        limit: 30,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ACT-0001");
    expect(sent[0]).toContain("Alice");
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
    const useCase = new ListTeamActions(actionsRepo, stubWireOutbound(sent));

    await useCase.execute({ conversationId: convId });

    expect(sent[0]).toContain("No open actions");
  });
});
