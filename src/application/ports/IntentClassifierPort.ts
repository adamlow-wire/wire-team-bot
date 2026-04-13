import type { Intent } from "../../domain/schemas/intent";

export interface IntentClassifierPort {
  /**
   * Classify the user's message into a structured intent.
   *
   * Always resolves — returns { type: "unknown", params: {} } on timeout or error.
   * @param text - The user's raw message (with bot-name prefix stripped).
   * @param conversationContext - Recent messages for disambiguation (last 3 are used).
   */
  classify(text: string, conversationContext?: string[]): Promise<Intent>;
}
