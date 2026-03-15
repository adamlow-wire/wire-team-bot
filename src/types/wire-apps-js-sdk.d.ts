declare module "wire-apps-js-sdk" {
  // ── Shared primitives ────────────────────────────────────────────────────────

  export interface QualifiedId {
    id: string;
    domain: string;
  }

  // ── Message base ─────────────────────────────────────────────────────────────

  interface WireMessageBase {
    id: string;
    type: string;
    conversationId: QualifiedId;
    sender: QualifiedId;
    timestamp: Date;
  }

  // ── Text message ─────────────────────────────────────────────────────────────

  export interface Mention {
    userId: QualifiedId;
    offset: number;
    length: number;
  }

  export interface TextMessage extends WireMessageBase {
    type: "text";
    text: string;
    mentions?: Mention[];
    quotedMessageId?: string | null;
    expiresAfterMillis?: number | null;
  }
  export const TextMessage: {
    create(params: {
      conversationId: QualifiedId;
      text: string;
      mentions?: Mention[];
      expiresAfterMillis?: number | null;
      quotedMessageId?: string | null;
    }): TextMessage;
  };

  // ── Composite message ─────────────────────────────────────────────────────────

  export interface Button {
    id: string;
    text: string;
  }

  export type CompositeItem =
    | { text: { content: string }; button?: never }
    | { button: Button; text?: never };

  export interface CompositeMessage extends WireMessageBase {
    type: "composite";
    items: CompositeItem[];
    expectsReadConfirmation?: boolean | null;
  }
  export const CompositeMessage: {
    create(params: {
      conversationId: QualifiedId;
      items: CompositeItem[];
      expectsReadConfirmation?: boolean | null;
    }): CompositeMessage;
  };

  // ── Button action messages ────────────────────────────────────────────────────

  export interface ButtonActionMessage extends WireMessageBase {
    type: "buttonAction";
    buttonId: string;
    referenceMessageId: string;
  }
  export const ButtonActionMessage: {
    create(params: {
      conversationId: QualifiedId;
      buttonId: string;
      referenceMessageId: string;
    }): ButtonActionMessage;
  };

  export interface ButtonActionConfirmationMessage extends WireMessageBase {
    type: "buttonActionConfirmation";
    referenceMessageId: string;
    buttonId?: string | null;
  }
  export const ButtonActionConfirmationMessage: {
    create(params: {
      conversationId: QualifiedId;
      referenceMessageId: string;
      buttonId?: string | null;
    }): ButtonActionConfirmationMessage;
  };

  // ── Reaction message ──────────────────────────────────────────────────────────

  export interface ReactionMessage extends WireMessageBase {
    type: "reaction";
    /** The emoji string, or empty string to remove all reactions. */
    emoji: string;
    targetMessageId: string;
  }
  export const ReactionMessage: {
    create(params: {
      conversationId: QualifiedId;
      emoji: string;
      targetMessageId: string;
    }): ReactionMessage;
  };

  // ── Asset message ─────────────────────────────────────────────────────────────

  export interface AssetMessage extends WireMessageBase {
    type: "asset";
    sizeInBytes: number;
    name?: string | null;
    mimeType: string;
  }

  // ── Other message types ───────────────────────────────────────────────────────

  export interface KnockMessage extends WireMessageBase {
    type: "knock";
    hotKnock: boolean;
  }

  export interface LocationMessage extends WireMessageBase {
    type: "location";
    longitude: number;
    latitude: number;
    name?: string | null;
    zoom?: number | null;
  }

  export interface MessageDeleteMessage extends WireMessageBase {
    type: "messageDelete";
    targetMessageId: string;
  }

  export interface MessageEditMessage extends WireMessageBase {
    type: "messageEdit";
    replacingMessageId: string;
    text?: string | null;
  }

  export interface ConfirmationMessage extends WireMessageBase {
    type: "confirmation";
    confirmationType: "delivered" | "read";
    firstMessageId: string;
    moreMessageIds?: string[];
  }

  export type WireMessage =
    | TextMessage
    | AssetMessage
    | CompositeMessage
    | ButtonActionMessage
    | ButtonActionConfirmationMessage
    | KnockMessage
    | LocationMessage
    | ReactionMessage
    | MessageDeleteMessage
    | MessageEditMessage
    | ConfirmationMessage;

  // ── Conversation ──────────────────────────────────────────────────────────────

  export interface Conversation {
    id: string;
    domain: string;
    name: string | null;
  }

  export interface ConversationMember {
    userId: QualifiedId;
    role: string;
  }

  // ── Asset upload ──────────────────────────────────────────────────────────────

  export interface Asset {
    data: Uint8Array;
    name: string;
    mimeType: string;
  }

  // ── Application manager ───────────────────────────────────────────────────────

  export class WireApplicationManager {
    sendMessage(message: WireMessage): Promise<string>;
    sendAsset(conversationId: QualifiedId, asset: Asset): Promise<string>;
    leaveConversation(conversationId: QualifiedId): Promise<void>;
    downloadAsset(assetRemoteData: unknown): Promise<Uint8Array>;
  }

  // ── Events handler ────────────────────────────────────────────────────────────

  export abstract class WireEventsHandler {
    get manager(): WireApplicationManager;

    onTextMessageReceived(wireMessage: TextMessage): Promise<void>;
    onAssetMessageReceived(wireMessage: AssetMessage): Promise<void>;
    onCompositeMessageReceived(wireMessage: CompositeMessage): Promise<void>;
    onButtonActionReceived(wireMessage: ButtonActionMessage): Promise<void>;
    onButtonActionConfirmationReceived(wireMessage: ButtonActionConfirmationMessage): Promise<void>;
    onKnockReceived(wireMessage: KnockMessage): Promise<void>;
    onLocationMessageReceived(wireMessage: LocationMessage): Promise<void>;
    onReactionReceived(wireMessage: ReactionMessage): Promise<void>;
    onMessageDeleted(wireMessage: MessageDeleteMessage): Promise<void>;
    onMessageEdited(wireMessage: MessageEditMessage): Promise<void>;
    onConfirmationReceived(wireMessage: ConfirmationMessage): Promise<void>;

    onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void>;
    onConversationDeleted(conversationId: QualifiedId): Promise<void>;
    onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void>;
    onUserLeftConversation(conversationId: QualifiedId, members: QualifiedId[]): Promise<void>;
  }

  // ── SDK entry point ───────────────────────────────────────────────────────────

  export class WireAppSdk {
    static create(
      userEmail: string,
      userPassword: string,
      userId: string,
      userDomain: string,
      apiHost: string,
      cryptographyStoragePassword: string,
      wireEventsHandler: WireEventsHandler,
      logger?: unknown,
    ): Promise<WireAppSdk>;

    startListening(): Promise<void>;
    stopListening(): void;
    close(): Promise<void>;
  }
}
