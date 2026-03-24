import { describe, it, expect, vi } from "vitest";
import { StatusCommand } from "../../src/application/usecases/general/StatusCommand";
import type { ChannelConfig } from "../../src/domain/repositories/ChannelConfigRepository";

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() });

function makeDeps(channelCfg: ChannelConfig | null, entityNames: string[] = []) {
  return {
    channelConfig: { get: vi.fn().mockResolvedValue(channelCfg), upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]) },
    entityRepo: { listNames: vi.fn().mockResolvedValue(entityNames), upsertWithDedup: vi.fn(), upsertRelationship: vi.fn() },
    wireOutbound: { sendPlainText: vi.fn().mockResolvedValue(undefined), sendCompositePrompt: vi.fn(), sendError: vi.fn() },
  };
}

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
    const cmd = new StatusCommand(deps.channelConfig as never, deps.entityRepo as never, deps.wireOutbound as never);

    await cmd.execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, msg] = (deps.wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(msg).toContain("active");
    expect(msg).toContain("Entities tracked: 3");
    expect(msg).toContain("3 days");
  });

  it("reports paused state", async () => {
    const cfg: ChannelConfig = {
      channelId, organisationId: "wire.com", state: "paused",
      secureRanges: [], timezone: "UTC", locale: "en",
    };
    const deps = makeDeps(cfg, []);
    const cmd = new StatusCommand(deps.channelConfig as never, deps.entityRepo as never, deps.wireOutbound as never);

    await cmd.execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const [, msg] = (deps.wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(msg).toContain("paused");
  });

  it("includes purpose when set", async () => {
    const cfg: ChannelConfig = {
      channelId, organisationId: "wire.com", state: "active",
      secureRanges: [], timezone: "UTC", locale: "en",
      purpose: "API platform team discussions",
    };
    const deps = makeDeps(cfg, []);
    const cmd = new StatusCommand(deps.channelConfig as never, deps.entityRepo as never, deps.wireOutbound as never);

    await cmd.execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const [, msg] = (deps.wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(msg).toContain("API platform team discussions");
  });

  it("falls back gracefully when no channel config exists", async () => {
    const deps = makeDeps(null, []);
    const cmd = new StatusCommand(deps.channelConfig as never, deps.entityRepo as never, deps.wireOutbound as never);

    await cmd.execute({ conversationId: convId, channelId, replyToMessageId: "msg-1" });

    const [, msg] = (deps.wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(msg).toContain("active"); // default state
    expect(msg).toContain("Entities tracked: 0");
  });
});
