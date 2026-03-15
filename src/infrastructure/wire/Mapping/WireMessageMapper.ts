import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { BufferedMessage } from "../../../application/services/ConversationMessageBuffer";

/**
 * Mapping helpers between wire-apps-js-sdk message DTOs and application-level types.
 * All SDK-specific field access is centralised here so that the rest of the
 * infrastructure layer (WireEventRouter, WireOutboundAdapter) stays clean.
 */

/**
 * Extract a QualifiedId from any SDK object that carries `id` and `domain` fields.
 * Falls back to a placeholder when either field is absent.
 */
export function toQualifiedId(obj: { id?: string; domain?: string } | undefined | null): QualifiedId {
  return {
    id: obj?.id ?? "",
    domain: obj?.domain ?? "",
  };
}

/**
 * Map a raw SDK TextMessage to the BufferedMessage shape used by ConversationMessageBuffer.
 * The `senderName` field is populated on a best-effort basis from known SDK fields.
 */
export function textMessageToBuffered(
  wireMessage: {
    id?: string;
    sender?: { id?: string; domain?: string };
    text?: string;
    [key: string]: unknown;
  },
): BufferedMessage {
  return {
    messageId: wireMessage.id ?? "",
    senderId: toQualifiedId(wireMessage.sender),
    senderName: (wireMessage.senderName as string | undefined) ?? "",
    text: (wireMessage.text as string | undefined) ?? "",
    timestamp: new Date(),
  };
}
