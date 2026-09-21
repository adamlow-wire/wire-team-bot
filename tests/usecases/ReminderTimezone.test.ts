import { describe, expect, it, vi } from "vitest";
import { CreateReminder } from "../../src/application/usecases/reminders/CreateReminder";
import { SnoozeReminder } from "../../src/application/usecases/reminders/SnoozeReminder";
import { ListMyReminders } from "../../src/application/usecases/reminders/ListMyReminders";
import type { Reminder } from "../../src/domain/entities/Reminder";
import type { ReminderRepository } from "../../src/domain/repositories/ReminderRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";

const conversationId = { id: "timezone-test", domain: "test.local" };
const authorId = { id: "alice", domain: "test.local" };

describe("reminder timezone display", () => {
  it.each([
    { timezone: undefined, instant: "2026-09-21T11:18:00.000Z", displayed: "11:18 UTC", snoozed: "12:18 UTC" },
    { timezone: "Europe/London", instant: "2026-09-21T11:18:00.000Z", displayed: "12:18 BST", snoozed: "13:18 BST" },
    { timezone: "Europe/London", instant: "2026-12-21T11:18:00.000Z", displayed: "11:18 GMT", snoozed: "12:18 GMT" },
  ])("labels create, list and snooze consistently: $instant / $timezone", async ({ timezone, instant, displayed, snoozed }) => {
    let saved: Reminder | undefined;
    const repo: ReminderRepository = {
      nextId: vi.fn().mockResolvedValue("REM-0001"),
      create: vi.fn(async reminder => { saved = reminder; return reminder; }),
      update: vi.fn(async reminder => { saved = reminder; return reminder; }),
      findById: vi.fn(async () => saved ?? null),
      query: vi.fn(async () => saved ? [saved] : []),
    };
    const wire: WireOutboundPort = {
      sendPlainText: vi.fn(), sendCompositePrompt: vi.fn(), sendReaction: vi.fn(), sendFile: vi.fn(), getUserProfile: vi.fn(),
    };
    const scheduler = { schedule: vi.fn(), cancel: vi.fn() };
    const audit = { append: vi.fn() };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
    const triggerAt = new Date(instant);
    const later = new Date(triggerAt.getTime() + 3600_000);
    const dates = { parse: vi.fn().mockReturnValue({ value: later, ambiguous: false }) };
    const created = await new CreateReminder(repo, dates, wire, scheduler, audit, logger).execute({
      conversationId, authorId, authorName: "Alice", rawMessageId: "timezone-source",
      description: "check timezone", targetId: authorId, triggerAt, timezone,
    });
    expect(wire.sendPlainText).toHaveBeenLastCalledWith(conversationId, expect.stringContaining(displayed), { replyToMessageId: "timezone-source" });
    expect(created.triggerAt.toISOString()).toBe(instant);
    expect(scheduler.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ runAt: triggerAt }));
    const list = new ListMyReminders(repo, wire);
    await list.execute({ conversationId, targetId: authorId, timezone });
    expect(wire.sendPlainText).toHaveBeenLastCalledWith(conversationId, expect.stringContaining(displayed), expect.anything());
    await new SnoozeReminder(repo, dates, scheduler, wire, audit).execute({
      reminderId: created.id, conversationId, actorId: authorId, snoozeExpression: "1 hour", timezone: timezone ?? "UTC",
    });
    expect(wire.sendPlainText).toHaveBeenLastCalledWith(conversationId, expect.stringContaining(snoozed), expect.anything());
    expect(saved?.triggerAt).toEqual(later);
    expect(scheduler.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ runAt: later }));
    await list.execute({ conversationId, targetId: authorId, timezone });
    expect(wire.sendPlainText).toHaveBeenLastCalledWith(conversationId, expect.stringContaining(snoozed), expect.anything());
  });
});
