import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";

function key(c: QualifiedId): string {
  return `${c.id}@${c.domain}`;
}

export class InMemoryMemberCache implements ConversationMemberCache {
  private cache = new Map<string, CachedMember[]>();

  setMembers(conversationId: QualifiedId, members: CachedMember[]): void {
    this.cache.set(key(conversationId), [...members]);
  }

  addMembers(conversationId: QualifiedId, members: CachedMember[]): void {
    const k = key(conversationId);
    const current = this.cache.get(k) ?? [];
    const byId = new Map(current.map((m) => [key(m.userId), m]));
    for (const m of members) {
      byId.set(key(m.userId), m);
    }
    this.cache.set(k, [...byId.values()]);
  }

  getMembers(conversationId: QualifiedId): CachedMember[] {
    return this.cache.get(key(conversationId)) ?? [];
  }

  removeMembers(conversationId: QualifiedId, userIds: QualifiedId[]): void {
    const k = key(conversationId);
    const current = this.cache.get(k) ?? [];
    const toRemove = new Set(userIds.map((u) => key(u)));
    const next = current.filter((m) => !toRemove.has(key(m.userId)));
    if (next.length === 0) this.cache.delete(k);
    else this.cache.set(k, next);
  }

  clearConversation(conversationId: QualifiedId): void {
    this.cache.delete(key(conversationId));
  }
}
