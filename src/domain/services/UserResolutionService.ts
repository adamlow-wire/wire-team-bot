import type { QualifiedId } from "../ids/QualifiedId";

export interface UserResolutionResult {
  userId: QualifiedId | null;
  ambiguous: boolean;
  candidates?: QualifiedId[];
  rawReference?: string;
}

/**
 * Port for resolving users from mentions or free-text references, backed
 * by the member cache and Wire SDK in infrastructure.
 */
export interface UserResolutionService {
  /** When userId is supplied, verify that exact qualified member; never fall back to the label. */
  resolveByHandleOrName(
    reference: string,
    options: { conversationId: QualifiedId; userId?: QualifiedId },
  ): Promise<UserResolutionResult>;
}
