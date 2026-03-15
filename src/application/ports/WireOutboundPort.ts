import type { QualifiedId } from "../../domain/ids/QualifiedId";

/** Options for plain-text send. replyToMessageId is ignored until the Wire SDK exposes reply-in-thread. */
export interface OutboundTextOptions {
  replyToMessageId?: string;
}

export interface CompositeButton {
  id: string;
  label: string;
}

/** Options for composite prompt. replyToMessageId is ignored until the SDK supports it. */
export interface CompositePromptOptions {
  replyToMessageId?: string;
}

export interface WireOutboundPort {
  sendPlainText(
    conversationId: QualifiedId,
    text: string,
    options?: OutboundTextOptions,
  ): Promise<void>;

  sendCompositePrompt(
    conversationId: QualifiedId,
    text: string,
    buttons: CompositeButton[],
    options?: CompositePromptOptions,
  ): Promise<void>;

  sendReaction(
    conversationId: QualifiedId,
    messageId: string,
    emoji: string,
  ): Promise<void>;

  /**
   * Send a file to a conversation.
   * @param fileStream - Readable stream of file bytes.
   * @param name - File name shown to recipients.
   * @param mimeType - MIME type of the file.
   * @param retention - Optional retention hint (e.g. "volatile", "persistent").
   */
  sendFile(
    conversationId: QualifiedId,
    fileStream: NodeJS.ReadableStream,
    name: string,
    mimeType: string,
    retention?: string,
  ): Promise<void>;
}

