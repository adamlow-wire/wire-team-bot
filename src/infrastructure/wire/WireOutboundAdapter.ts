import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  WireOutboundPort,
  OutboundTextOptions,
  CompositePromptOptions,
  CompositeButton as PromptButton,
  UserProfile,
} from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import { TextMessage, CompositeMessage, CompositeButton, Reaction } from "@wireapp/wire-apps-js-sdk";
import type { WireMessage, WireUser } from "@wireapp/wire-apps-js-sdk";

/**
 * The subset of WireApplicationManager the outbound adapter needs.
 * Kept narrow so tests can supply a fake without the SDK's native dependencies.
 */
export interface ManagerHandle {
  sendMessage(message: WireMessage): Promise<string>;
  sendAsset(conversationId: QualifiedId, asset: { data: Uint8Array; name: string; mimeType: string }): Promise<string>;
  getUsers(userIds: QualifiedId[]): Promise<Array<Pick<WireUser, "id" | "name" | "handle">>>;
}

export interface HandlerManagerRef {
  current: { manager?: ManagerHandle } | null;
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
 * Implements WireOutboundPort using @wireapp/wire-apps-js-sdk.
 */
export function createWireOutboundAdapter(handlerRef: HandlerManagerRef, logger: Logger): WireOutboundPort {
  return {
    async getUserProfile(userId: QualifiedId): Promise<UserProfile | null> {
      const h = handlerRef.current;
      if (!h?.manager) return null;
      try {
        const [profile] = await h.manager.getUsers([userId]);
        if (!profile) return null;
        return {
          id: { id: profile.id.id, domain: profile.id.domain },
          name: profile.name,
          handle: profile.handle,
        };
      } catch {
        return null;
      }
    },

    async sendPlainText(
      conversationId: QualifiedId,
      text: string,
      options?: OutboundTextOptions,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendPlainText", { conversationId: conversationId.id, textLength: text.length });
      await h.manager.sendMessage(TextMessage.create({ conversationId, text, mentions: options?.mentions }));
    },

    async sendCompositePrompt(
      conversationId: QualifiedId,
      text: string,
      buttons: PromptButton[],
      _options?: CompositePromptOptions,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendCompositePrompt", { conversationId: conversationId.id, textLength: text.length, buttons: buttons.map((b) => b.id) });
      await h.manager.sendMessage(
        CompositeMessage.create({
          conversationId,
          text,
          itemList: buttons.map((b) => CompositeButton.create({ id: b.id, text: b.label })),
        }),
      );
    },

    async sendReaction(
      conversationId: QualifiedId,
      messageId: string,
      emoji: string | readonly string[],
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendReaction", { conversationId: conversationId.id, messageId, emoji });
      await h.manager.sendMessage(
        Reaction.create({ conversationId, messageId, emojiSet: new Set(typeof emoji === "string" ? [emoji] : emoji) }),
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
