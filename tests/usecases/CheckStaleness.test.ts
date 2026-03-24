import { describe, it, expect, vi } from "vitest";
import { CheckStaleness } from "../../src/application/usecases/actions/CheckStaleness";

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
});

const now = new Date("2026-03-20T10:00:00Z");
const convId = { id: "conv-1", domain: "wire.com" };

function makeAction(overrides = {}) {
  return {
    id: "ACT-0001",
    description: "Write the migration script",
    assigneeId: { id: "u1", domain: "wire.com" },
    assigneeName: "Alice",
    conversationId: convId,
    status: "open" as const,
    deadline: new Date(now.getTime() - 2 * 86_400_000), // 2 days overdue
    stalenessAt: null,
    lastStatusCheck: null,
    timestamp: new Date("2026-03-01"),
    deleted: false,
    ...overrides,
  };
}

describe("CheckStaleness", () => {
  it("sends a nudge for an overdue action not recently checked", async () => {
    const action = makeAction();
    const actionRepo = {
      query: vi.fn().mockResolvedValue([action]),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("Alice");
    expect(text).toContain("Write the migration script");
    expect(text).toContain("days ago");
  });

  it("updates lastStatusCheck after nudging", async () => {
    const action = makeAction();
    const actionRepo = {
      query: vi.fn().mockResolvedValue([action]),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(actionRepo.update).toHaveBeenCalledOnce();
    const updated = (actionRepo.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updated.lastStatusCheck).toBeInstanceOf(Date);
  });

  it("skips actions that were recently checked (< 24 h ago)", async () => {
    const action = makeAction({ lastStatusCheck: new Date(Date.now() - 30 * 60 * 1000) }); // 30 min ago
    const actionRepo = {
      query: vi.fn().mockResolvedValue([action]),
      update: vi.fn(),
    };
    const wireOutbound = { sendPlainText: vi.fn() };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("skips deleted actions", async () => {
    const action = makeAction({ deleted: true });
    const actionRepo = {
      query: vi.fn().mockResolvedValue([action]),
      update: vi.fn(),
    };
    const wireOutbound = { sendPlainText: vi.fn() };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("sends staleness nudge (no deadline) for action past stalenessAt", async () => {
    const action = makeAction({
      deadline: null,
      stalenessAt: new Date(Date.now() - 1 * 86_400_000), // triggered yesterday
    });
    const actionRepo = {
      query: vi.fn().mockResolvedValue([action]),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("no update for some time");
  });

  it("does nothing when there are no stale actions", async () => {
    const actionRepo = { query: vi.fn().mockResolvedValue([]) };
    const wireOutbound = { sendPlainText: vi.fn() };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    await uc.execute();

    expect(wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("continues if actionRepo.query throws", async () => {
    const actionRepo = { query: vi.fn().mockRejectedValue(new Error("DB down")) };
    const wireOutbound = { sendPlainText: vi.fn() };

    const uc = new CheckStaleness(actionRepo as never, wireOutbound as never, makeLogger());
    // Should not throw
    await expect(uc.execute()).resolves.toBeUndefined();
  });
});
