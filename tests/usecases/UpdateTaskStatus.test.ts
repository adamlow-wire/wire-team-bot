import { describe, it, expect, vi } from "vitest";
import { UpdateTaskStatus } from "../../src/application/usecases/tasks/UpdateTaskStatus";
import type { TaskRepository } from "../../src/domain/repositories/TaskRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Task } from "../../src/domain/entities/Task";

describe("UpdateTaskStatus", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const actorId: QualifiedId = { id: "user-1", domain: "wire.com" };

  const existingTask: Task = {
    id: "TASK-0001",
    conversationId: convId,
    authorId: actorId,
    authorName: "Alice",
    rawMessageId: "msg-1",
    rawMessage: "task: Deploy",
    timestamp: new Date(),
    updatedAt: new Date(),
    tags: [],
    status: "open",
    deleted: false,
    version: 1,
    description: "Deploy",
    assigneeId: actorId,
    assigneeName: "Alice",
    creatorId: actorId,
    deadline: null,
    priority: "normal",
    recurrence: null,
    linkedIds: [],
    completionNote: null,
  };

  it("updates task status and sends reply", async () => {
    const tasksRepo: TaskRepository = {
      findById: vi.fn().mockResolvedValue(existingTask),
      update: vi.fn().mockImplementation(async (t) => t),
      create: vi.fn(),
      query: vi.fn(),
      nextId: vi.fn(),
    };

    const sent: { text: string }[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => {
        sent.push({ text });
      }),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new UpdateTaskStatus(tasksRepo, wireOutbound, auditLog);

    const result = await useCase.execute({
      taskId: "TASK-0001",
      newStatus: "done",
      conversationId: convId,
      actorId,
      completionNote: "Shipped.",
      replyToMessageId: "msg-2",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    expect(result!.completionNote).toBe("Shipped.");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("done");
  });

  it("returns null when task not found or wrong conversation", async () => {
    const tasksRepo: TaskRepository = {
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn(),
      query: vi.fn(),
      nextId: vi.fn(),
    };

    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn(),
      sendCompositePrompt: vi.fn(),
      sendReaction: vi.fn(),
      sendFile: vi.fn(),
    };

    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const useCase = new UpdateTaskStatus(tasksRepo, wireOutbound, auditLog);
    const result = await useCase.execute({
      taskId: "TASK-9999",
      newStatus: "done",
      conversationId: convId,
      actorId,
    });

    expect(result).toBeNull();
    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});
