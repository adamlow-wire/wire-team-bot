import type {
  ConversationConfig,
  ConversationConfigRepository,
} from "../../../domain/repositories/ConversationConfigRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";

/** Returns the canonical channel_id string used in channel_config. */
function toChannelId(q: QualifiedId): string {
  return `${q.id}@${q.domain}`;
}

/**
 * Phase 1b: ConversationConfig table has been dropped.
 * This adapter reads from channel_config (the Phase 1a replacement) and maps
 * the fields that callers still need (timezone, locale, purpose, secretMode).
 *
 * upsert() is a no-op — all writes go through ChannelConfigRepository directly.
 */
export class PrismaConversationConfigRepository implements ConversationConfigRepository {
  private prisma = getPrismaClient();

  async get(conversationId: QualifiedId): Promise<ConversationConfig | null> {
    const channelId = toChannelId(conversationId);
    const row = await this.prisma.channelConfig.findUnique({ where: { channelId } });
    if (!row) return null;
    return {
      conversationId,
      timezone: row.timezone,
      locale: row.locale,
      secretMode: row.state === "secure",
      purpose: row.purpose ?? undefined,
      raw: null,
    };
  }

  async upsert(config: ConversationConfig): Promise<ConversationConfig> {
    // All persistent config is now managed via ChannelConfigRepository.
    return config;
  }
}
