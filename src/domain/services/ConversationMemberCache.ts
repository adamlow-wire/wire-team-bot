import type { QualifiedId } from "../ids/QualifiedId";

export type ConversationRole = "admin" | "member";

export interface CachedMember {
  userId: QualifiedId;
  role: ConversationRole;
  /** Display name as reported by the Wire SDK, if available. */
  name?: string;
}

/**
 * Port for the in-app conversation member cache. Updated from Wire lifecycle events
 * (onAppAddedToConversation, onUserJoinedConversation, onUserLeftConversation).
 * Used for user resolution and permission checks.
 */
export interface ConversationMemberCache {
  /** Replace the full member list for a conversation (used on app-added event). */
  setMembers(conversationId: QualifiedId, members: CachedMember[]): void;
  /** Merge/upsert members into an existing cache entry (used on user-joined event). */
  addMembers(conversationId: QualifiedId, members: CachedMember[]): void;
  getMembers(conversationId: QualifiedId): CachedMember[];
  removeMembers(conversationId: QualifiedId, userIds: QualifiedId[]): void;
  clearConversation(conversationId: QualifiedId): void;
}
