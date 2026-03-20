import type { QualifiedId } from "../../domain/ids/QualifiedId";

/** Canonical channel_id string: "{conversationId}@{conversationDomain}" */
export function toChannelId(q: QualifiedId): string {
  return `${q.id}@${q.domain}`;
}

/** Parse a channel_id back into a QualifiedId. */
export function fromChannelId(channelId: string): QualifiedId {
  const at = channelId.lastIndexOf("@");
  if (at < 0) throw new Error(`Invalid channel_id: ${channelId}`);
  return { id: channelId.slice(0, at), domain: channelId.slice(at + 1) };
}
