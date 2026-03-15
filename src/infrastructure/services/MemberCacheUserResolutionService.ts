import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  UserResolutionService,
  UserResolutionResult,
} from "../../domain/services/UserResolutionService";
import type { ConversationMemberCache } from "../../domain/services/ConversationMemberCache";

/**
 * Resolves a user reference (e.g. "@alice", "Alice", or a raw user ID) against
 * the in-memory conversation member cache.
 *
 * Matching strategy (in order):
 *  1. Strip leading "@" and compare lowercased against the userId.id field.
 *  2. Compare lowercased against the cached display name.
 *
 * Returns ambiguous=true when more than one member matches.
 * Falls back to null userId when no match is found.
 */
export class MemberCacheUserResolutionService implements UserResolutionService {
  constructor(private readonly memberCache: ConversationMemberCache) {}

  async resolveByHandleOrName(
    reference: string,
    options: { conversationId: QualifiedId },
  ): Promise<UserResolutionResult> {
    const normalised = reference.replace(/^@/, "").trim().toLowerCase();
    if (!normalised) {
      return { userId: null, ambiguous: false };
    }

    const members = this.memberCache.getMembers(options.conversationId);
    const matches = members.filter(
      (m) =>
        m.userId.id.toLowerCase() === normalised ||
        (m.name != null && m.name.toLowerCase() === normalised),
    );

    if (matches.length === 0) {
      return { userId: null, ambiguous: false, rawReference: reference };
    }
    if (matches.length > 1) {
      return {
        userId: null,
        ambiguous: true,
        candidates: matches.map((m) => m.userId),
        rawReference: reference,
      };
    }
    return { userId: matches[0]!.userId, ambiguous: false };
  }
}
