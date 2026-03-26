import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";

function key(c: QualifiedId): string {
  return `${c.id}@${c.domain}`;
}

export class InMemoryMemberCache implements ConversationMemberCache {
  private cache = new Map<string, CachedMember[]>();

  setMembers(conversationId: QualifiedId, members: CachedMember[]): void {
    this.cache.set(key(conversationId), members.map(stampIfNamed));
  }

  addMembers(conversationId: QualifiedId, members: CachedMember[]): void {
    const k = key(conversationId);
    const current = this.cache.get(k) ?? [];
    const byId = new Map(current.map((m) => [key(m.userId), m]));
    for (const m of members) {
      byId.set(key(m.userId), stampIfNamed(m));
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

  updateMemberName(conversationId: QualifiedId, userId: QualifiedId, name: string): void {
    const k = key(conversationId);
    const members = this.cache.get(k);
    if (!members) return;
    const idx = members.findIndex((m) => key(m.userId) === key(userId));
    if (idx !== -1) members[idx] = { ...members[idx]!, name, nameResolvedAt: new Date() };
  }
}

/**
 * If a member already has a name when inserted, stamp nameResolvedAt so the
 * TTL-based lazy resolver does not treat it as infinitely stale and launch a
 * redundant background fetch on the very next message.
 */
function stampIfNamed(m: CachedMember): CachedMember {
  return m.name && !m.nameResolvedAt ? { ...m, nameResolvedAt: new Date() } : m;
}
