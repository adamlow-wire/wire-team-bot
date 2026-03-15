import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  WireOutboundPort,
  OutboundTextOptions,
  CompositePromptOptions,
  CompositeButton,
} from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import { TextMessage, CompositeMessage, ReactionMessage } from "wire-apps-js-sdk";
import type { WireApplicationManager } from "wire-apps-js-sdk";

/**
 * Ref to the current Wire events handler. The SDK sets handler.manager after create;
 * the adapter uses this to send messages.
 */
export interface HandlerManagerRef {
  current: { manager?: Pick<WireApplicationManager, "sendMessage" | "sendAsset"> } | null;
}

async function streamToUint8Array(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", reject);
  });
}

/**
 * Implements WireOutboundPort using wire-apps-js-sdk.
 */
export function createWireOutboundAdapter(handlerRef: HandlerManagerRef, logger: Logger): WireOutboundPort {
  return {
    async sendPlainText(
      conversationId: QualifiedId,
      text: string,
      _options?: OutboundTextOptions,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendPlainText", { conversationId: conversationId.id, preview: text.slice(0, 80) });
      await h.manager.sendMessage(TextMessage.create({ conversationId, text }));
    },

    async sendCompositePrompt(
      conversationId: QualifiedId,
      text: string,
      buttons: CompositeButton[],
      _options?: CompositePromptOptions,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendCompositePrompt", { conversationId: conversationId.id, preview: text.slice(0, 80), buttons: buttons.map((b) => b.id) });
      const items = [
        { text: { content: text } },
        ...buttons.map((b) => ({ button: { id: b.id, text: b.label } })),
      ];
      await h.manager.sendMessage(CompositeMessage.create({ conversationId, items }));
    },

    async sendReaction(
      conversationId: QualifiedId,
      messageId: string,
      emoji: string,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendReaction", { conversationId: conversationId.id, messageId, emoji });
      await h.manager.sendMessage(
        ReactionMessage.create({ conversationId, emoji, targetMessageId: messageId }),
      );
    },

    async sendFile(
      conversationId: QualifiedId,
      fileStream: NodeJS.ReadableStream,
      name: string,
      mimeType: string,
      _retention?: string,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendFile", { conversationId: conversationId.id, name, mimeType });
      const data = await streamToUint8Array(fileStream);
      await h.manager.sendAsset(conversationId, { data, name, mimeType });
    },
  };
}
