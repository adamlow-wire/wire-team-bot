/**
 * Contract tests for WireOutboundAdapter.
 *
 * Verifies that each WireOutboundPort operation produces the expected SDK calls
 * using a fake SDK handler/manager.
 */
import { describe, it, expect, vi } from "vitest";
import { createWireOutboundAdapter } from "../../src/infrastructure/wire/WireOutboundAdapter";
import type { HandlerManagerRef } from "../../src/infrastructure/wire/WireOutboundAdapter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };

function makeRef(
  sendMessage: (m: unknown) => Promise<string> = vi.fn().mockResolvedValue("msg-id"),
  sendAsset: (conversationId: unknown, asset: unknown) => Promise<string> = vi.fn().mockResolvedValue("asset-id"),
): HandlerManagerRef {
  return { current: { manager: { sendMessage, sendAsset, getUsers: vi.fn().mockResolvedValue([]) } } };
}

describe("WireOutboundAdapter contract", () => {
  it("sendPlainText calls manager.sendMessage with a TextMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendPlainText(convId, "Hello world");
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as { text?: string };
    expect(arg.text ?? (arg as { text: string }).text).toBe("Hello world");
  });

  it("sendCompositePrompt sends a CompositeMessage with a leading text item and button items", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendCompositePrompt(convId, "Any actions?", [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as {
      type?: string;
      conversationId?: QualifiedId;
      items?: Array<{ type?: string; text?: string; id?: string }>;
    };
    expect(arg.type).toBe("composite");
    expect(arg.conversationId).toEqual(convId);
    expect(arg.items).toHaveLength(3);
    expect(arg.items?.[0]).toMatchObject({ type: "text", text: "Any actions?" });
    expect(arg.items?.[1]).toMatchObject({ type: "composite_button", id: "yes", text: "Yes" });
    expect(arg.items?.[2]).toMatchObject({ type: "composite_button", id: "no", text: "No" });
  });

  it("sendReaction calls manager.sendMessage with a Reaction carrying the emoji set", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendReaction(convId, "msg-1", "✓");
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as { type?: string; messageId?: string; emojiSet?: Set<string> };
    expect(arg.type).toBe("reaction");
    expect(arg.messageId).toBe("msg-1");
    expect(arg.emojiSet).toBeInstanceOf(Set);
    expect([...(arg.emojiSet ?? [])]).toEqual(["✓"]);
  });

  it("getUserProfile resolves via manager.getUsers and maps the first result", async () => {
    const getUsers = vi.fn().mockResolvedValue([
      { id: { id: "user-1", domain: "wire.com" }, name: "Ada", handle: "ada" },
    ]);
    const ref: HandlerManagerRef = { current: { manager: { sendMessage: vi.fn(), sendAsset: vi.fn(), getUsers } } };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    const profile = await adapter.getUserProfile({ id: "user-1", domain: "wire.com" });
    expect(getUsers).toHaveBeenCalledWith([{ id: "user-1", domain: "wire.com" }]);
    expect(profile).toEqual({ id: { id: "user-1", domain: "wire.com" }, name: "Ada", handle: "ada" });
  });

  it("getUserProfile returns null when getUsers yields nothing", async () => {
    const getUsers = vi.fn().mockResolvedValue([]);
    const ref: HandlerManagerRef = { current: { manager: { sendMessage: vi.fn(), sendAsset: vi.fn(), getUsers } } };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    await expect(adapter.getUserProfile({ id: "ghost", domain: "wire.com" })).resolves.toBeNull();
  });

  it("sendFile calls manager.sendAsset with Uint8Array data", async () => {
    const sendAsset = vi.fn().mockResolvedValue("asset-id");
    const adapter = createWireOutboundAdapter(makeRef(undefined, sendAsset), mockLogger);
    const { Readable } = await import("stream");
    const stream = Readable.from([Buffer.from("hello")]);
    await adapter.sendFile(convId, stream, "report.pdf", "application/pdf");
    expect(sendAsset).toHaveBeenCalledOnce();
    const [calledConvId, asset] = sendAsset.mock.calls[0]! as [unknown, { data: Uint8Array; name: string; mimeType: string }];
    expect(calledConvId).toEqual(convId);
    expect(asset.name).toBe("report.pdf");
    expect(asset.mimeType).toBe("application/pdf");
    expect(asset.data).toBeInstanceOf(Uint8Array);
  });

  it("sendPlainText is a no-op when the manager is not yet set", async () => {
    const ref: HandlerManagerRef = { current: null };
    const adapter = createWireOutboundAdapter(ref, mockLogger);
    // Should resolve without throwing
    await expect(adapter.sendPlainText(convId, "hi")).resolves.toBeUndefined();
  });
});
