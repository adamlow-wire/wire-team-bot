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
  return { current: { manager: { sendMessage, sendAsset } } };
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

  it("sendCompositePrompt sends a CompositeMessage with text item and button items", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendCompositePrompt(convId, "Any actions?", [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as {
      type?: string;
      items?: Array<{ text?: { content: string }; button?: { id: string; text: string } }>;
    };
    expect(arg.type).toBe("composite");
    expect(arg.items?.[0]?.text?.content).toBe("Any actions?");
    expect(arg.items?.[1]?.button).toEqual({ id: "yes", text: "Yes" });
    expect(arg.items?.[2]?.button).toEqual({ id: "no", text: "No" });
  });

  it("sendReaction calls manager.sendMessage with a ReactionMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue("ok");
    const adapter = createWireOutboundAdapter(makeRef(sendMessage), mockLogger);
    await adapter.sendReaction(convId, "msg-1", "✓");
    expect(sendMessage).toHaveBeenCalledOnce();
    const arg = sendMessage.mock.calls[0]![0] as { type?: string; emoji?: string; targetMessageId?: string };
    expect(arg.type).toBe("reaction");
    expect(arg.emoji).toBe("✓");
    expect(arg.targetMessageId).toBe("msg-1");
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
