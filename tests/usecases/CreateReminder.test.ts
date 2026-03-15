import { describe, it, expect, vi } from "vitest";
import { CreateReminder } from "../../src/application/usecases/reminders/CreateReminder";
import type { ReminderRepository } from "../../src/domain/repositories/ReminderRepository";
import type { DateTimeService } from "../../src/domain/services/DateTimeService";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { SchedulerPort } from "../../src/application/ports/SchedulerPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

describe("CreateReminder", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const authorId: QualifiedId = { id: "user-1", domain: "wire.com" };
  const triggerAt = new Date(Date.now() + 60 * 60 * 1000);

  it("creates reminder, schedules job, and sends reply", async () => {
    const remindersRepo: ReminderRepository = {
      nextId: vi.fn().mockResolvedValue("REM-0001"),
      create: vi.fn().mockImplementation(async (r) => r),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn(),
    };

    const dateTimeService: DateTimeService = {
      parse: vi.fn().mockReturnValue(null),
    };

    const scheduled: { id: string; runAt: Date; type: string; payload: unknown }[] = [];
    const scheduler: SchedulerPort = {
      schedule: vi.fn().mockImplementation((job) => {
        scheduled.push(job);
      }),
      cancel: vi.fn(),
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
    const useCase = new CreateReminder(
      remindersRepo,
      dateTimeService,
      wireOutbound,
      scheduler,
      auditLog,
    );

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "Alice",
      rawMessageId: "msg-1",
      rawMessage: "reminder: Call John",
      description: "Call John",
      targetId: authorId,
      triggerAt,
    });

    expect(result.id).toBe("REM-0001");
    expect(result.description).toBe("Call John");
    expect(result.status).toBe("pending");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].type).toBe("reminder");
    expect((scheduled[0].payload as { reminderId: string }).reminderId).toBe("REM-0001");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("REM-0001");
    expect(sent[0].text).toContain("Call John");
  });
});
