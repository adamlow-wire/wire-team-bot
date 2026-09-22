import { describe, it, expect, vi } from "vitest";
import { StatusCommand } from "../../src/application/usecases/general/StatusCommand";
import type { ChannelConfig } from "../../src/domain/repositories/ChannelConfigRepository";

interface RecordCounts {
  actions?: Array<{ deleted: boolean }>;
  reminders?: Array<{ deleted: boolean }>;
  decisions?: Array<{ deleted: boolean }>;
}

function makeDeps(channelCfg: ChannelConfig | null, entityNames: string[] = [], records: RecordCounts = {}) {
  return {
    channelConfig: { get: vi.fn().mockResolvedValue(channelCfg), upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]) },
    entityRepo: { listNames: vi.fn().mockResolvedValue(entityNames), upsertWithDedup: vi.fn(), upsertRelationship: vi.fn() },
    actionRepo: { query: vi.fn().mockResolvedValue(records.actions ?? []), create: vi.fn(), update: vi.fn(), findById: vi.fn(), nextId: vi.fn() },
    reminderRepo: { query: vi.fn().mockResolvedValue(records.reminders ?? []), create: vi.fn(), update: vi.fn(), findById: vi.fn(), nextId: vi.fn() },
    decisionRepo: { query: vi.fn().mockResolvedValue(records.decisions ?? []), create: vi.fn(), update: vi.fn(), findById: vi.fn(), nextId: vi.fn() },
    wireOutbound: { sendPlainText: vi.fn().mockResolvedValue(undefined), sendCompositePrompt: vi.fn(), sendError: vi.fn() },
  };
}

function makeCommand(deps: ReturnType<typeof makeDeps>): StatusCommand {
  return new StatusCommand(
    deps.channelConfig as never,
    deps.entityRepo as never,
    deps.actionRepo as never,
    deps.reminderRepo as never,
    deps.decisionRepo as never,
    deps.wireOutbound as never,
  );
}

function sentMessage(deps: ReturnType<typeof makeDeps>): string {
  const [, msg] = (deps.wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
  return msg;
}

const live = (n: number) => Array.from({ length: n }, () => ({ deleted: false }));

const convId = { id: "conv-1", domain: "wire.com" };
const channelId = "conv-1@wire.com";

describe("StatusCommand", () => {
  it("reports active state and entity count", async () => {
    const cfg: ChannelConfig = {
      channelId, organisationId: "wire.com", state: "active",
      secureRanges: [], timezone: "UTC", locale: "en",
      joinedAt: new Date(Date.now() - 3 * 86_400_000), // 3 days ago
    };
    const deps = makeDeps(cfg, ["Alice", "ProjectX", "Wire"]);

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const msg = sentMessage(deps);
    expect(msg).toContain("active");
    expect(msg).toContain("Knowledge graph entities: 3");
    expect(msg).toContain("3 days");
  });

  it("reports paused state", async () => {
    const cfg: ChannelConfig = {
      channelId, organisationId: "wire.com", state: "paused",
      secureRanges: [], timezone: "UTC", locale: "en",
    };
    const deps = makeDeps(cfg, []);

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(sentMessage(deps)).toContain("paused");
  });

  it("includes purpose when set", async () => {
    const cfg: ChannelConfig = {
      channelId, organisationId: "wire.com", state: "active",
      secureRanges: [], timezone: "UTC", locale: "en",
      purpose: "API platform team discussions",
    };
    const deps = makeDeps(cfg, []);

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(sentMessage(deps)).toContain("API platform team discussions");
  });

  it("falls back gracefully when no channel config exists", async () => {
    const deps = makeDeps(null, []);

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const msg = sentMessage(deps);
    expect(msg).toContain("active"); // default state
    expect(msg).toContain("Open actions: 0");
    expect(msg).toContain("Knowledge graph entities: 0");
  });

  it("reports open records when explicit commands have created no entities", async () => {
    // Explicit decision:/action:/remind me commands bypass passive extraction, so a
    // channel can have open work and zero knowledge graph entities at the same time.
    const deps = makeDeps(null, [], { actions: live(1), reminders: live(1), decisions: live(1) });

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const msg = sentMessage(deps);
    expect(msg).toContain("Open actions: 1");
    expect(msg).toContain("Pending reminders: 1");
    expect(msg).toContain("Active decisions: 1");
    expect(msg).toContain("Knowledge graph entities: 0");
    expect(msg).not.toContain("Entities tracked");
  });

  it("scopes each count to the qualified conversation with the list-command status sets", async () => {
    const deps = makeDeps(null, []);

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(deps.actionRepo.query).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: convId, statusIn: ["open", "in_progress", "overdue"],
    }));
    expect(deps.reminderRepo.query).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: convId, statusIn: ["pending"],
    }));
    expect(deps.decisionRepo.query).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: convId, statusIn: ["active"],
    }));
  });

  it("excludes deleted records from the counts", async () => {
    const deps = makeDeps(null, [], {
      actions: [{ deleted: false }, { deleted: true }, { deleted: false }],
      reminders: [{ deleted: true }],
      decisions: [{ deleted: false }, { deleted: true }],
    });

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const msg = sentMessage(deps);
    expect(msg).toContain("Open actions: 2");
    expect(msg).toContain("Pending reminders: 0");
    expect(msg).toContain("Active decisions: 1");
  });

  it("marks capped action and decision counts as a lower bound", async () => {
    const deps = makeDeps(null, [], { actions: live(100), decisions: live(100) });

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const msg = sentMessage(deps);
    expect(msg).toContain("Open actions: 100+");
    expect(msg).toContain("Active decisions: 100+");
  });

  it("reports the reminder count exactly because that query is unbounded", async () => {
    const deps = makeDeps(null, [], { reminders: live(150) });

    await makeCommand(deps).execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(sentMessage(deps)).toContain("Pending reminders: 150");
    expect(sentMessage(deps)).not.toContain("Pending reminders: 150+");
  });
});
