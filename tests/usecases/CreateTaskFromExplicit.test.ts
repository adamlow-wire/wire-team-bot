import { describe, it, expect, vi } from "vitest";
import { CreateTaskFromExplicit } from "../../src/application/usecases/tasks/CreateTaskFromExplicit";
import type { TaskRepository } from "../../src/domain/repositories/TaskRepository";
import type { ConversationConfigRepository } from "../../src/domain/repositories/ConversationConfigRepository";
import type { DateTimeService } from "../../src/domain/services/DateTimeService";
import type { UserResolutionService } from "../../src/domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

describe("CreateTaskFromExplicit", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const authorId: QualifiedId = { id: "user-1", domain: "wire.com" };

  it("creates task and sends reply", async () => {
    const created: { id: string; description: string } = { id: "", description: "" };
    const tasksRepo: TaskRepository = {
      nextId: vi.fn().mockResolvedValue("TASK-0001"),
      create: vi.fn().mockImplementation(async (task) => {
        created.id = task.id;
        created.description = task.description;
        return task;
      }),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn(),
    };

    const conversationConfig: ConversationConfigRepository = {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(async (c) => c),
    };

    const dateTimeService: DateTimeService = {
      parse: vi.fn().mockReturnValue(null),
    };

    const userResolutionService: UserResolutionService = {
      resolveByHandleOrName: vi.fn().mockResolvedValue({ userId: authorId, ambiguous: false }),
    };

    const sent: { convId: QualifiedId; text: string }[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (c, text) => {
        sent.push({ convId: c, text });
      }),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
    const useCase = new CreateTaskFromExplicit(
      tasksRepo,
      conversationConfig,
      dateTimeService,
      userResolutionService,
      wireOutbound,
      auditLog,
      mockLogger,
    );

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "Alice",
      rawMessageId: "msg-1",
      rawMessage: "task: Deploy to prod",
      description: "Deploy to prod",
    });

    expect(result.id).toBe("TASK-0001");
    expect(result.description).toBe("Deploy to prod");
    expect(result.status).toBe("open");
    expect(created.id).toBe("TASK-0001");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("TASK-0001");
    expect(sent[0].text).toContain("Deploy to prod");
  });
});
