/**
 * Vitest stub for wire-apps-js-sdk.
 *
 * The real SDK has a transitive WASM dependency (@wireapp/core-crypto) that
 * Vite cannot resolve in the Node test environment.  This file provides the
 * minimal runtime surface that WireEventRouter and WireOutboundAdapter need,
 * while leaving all SDK types intact (they are imported as `import type …`
 * and are therefore erased at test time anyway).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = Record<string, any>;

export class WireEventsHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected manager: any = { sendMessage: async () => {} };
}

export class ButtonActionConfirmationMessage {
  static create(args: AnyArgs) { return args; }
}

/** Passes through args so tests can inspect the message fields directly. */
export class TextMessage {
  static create(args: AnyArgs) { return args; }
}

export class CompositeMessage {
  static create(args: AnyArgs) { return { type: "composite", ...args }; }
}

export class ReactionMessage {
  static create(args: AnyArgs) { return { type: "reaction", ...args }; }
}

// Re-export all types as empty — only used as `import type` so no runtime value needed.
export type Conversation = Record<string, unknown>;
export type ConversationMember = Record<string, unknown>;
export type ButtonActionMessage = Record<string, unknown>;
export type MessageEditMessage = Record<string, unknown>;
