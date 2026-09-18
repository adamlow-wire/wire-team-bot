import { TextMessage } from "@wireapp/wire-apps-js-sdk";
import type { QualifiedId } from "../../domain/ids/QualifiedId";

type Quote = Pick<TextMessage, "quotedMessageId" | "quotedMessageSha256">;

/** Only source IDs and SDK integrity hashes live here, never message bodies. */
export class WireReplyContext {
  private readonly quotes = new Map<string, Quote>();

  private key(conversationId: QualifiedId, messageId: string): string {
    return JSON.stringify([conversationId.id, conversationId.domain, messageId]);
  }

  async withMessage<T>(source: TextMessage, handle: () => Promise<T>): Promise<T> {
    // Wire does not allow replies to self-deleting messages. Missing timestamps
    // cannot produce a valid integrity hash; still allow the normal response.
    if (source.expiresAfterMillis || !Number.isFinite(new Date(source.timestamp).getTime())) {
      return handle();
    }
    const reply = TextMessage.createReply({ originalMessage: source, text: "" });
    const key = this.key(source.conversationId, source.id);
    const quote: Quote = {
      quotedMessageId: reply.quotedMessageId,
      quotedMessageSha256: reply.quotedMessageSha256,
    };
    this.quotes.set(key, quote);
    try {
      return await handle();
    } finally {
      if (this.quotes.get(key) === quote) this.quotes.delete(key);
    }
  }

  get(conversationId: QualifiedId, messageId?: string): Quote | undefined {
    return messageId ? this.quotes.get(this.key(conversationId, messageId)) : undefined;
  }
}
