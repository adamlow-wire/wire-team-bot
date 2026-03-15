import type {
  ConversationConfig,
  ConversationConfigRepository,
  ImplicitSensitivity,
} from "../../../domain/repositories/ConversationConfigRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";

export class PrismaConversationConfigRepository implements ConversationConfigRepository {
  private prisma = getPrismaClient();

  async get(conversationId: QualifiedId): Promise<ConversationConfig | null> {
    const row = await this.prisma.conversationConfig.findUnique({
      where: {
        conversationId_conversationDom: {
          conversationId: conversationId.id,
          conversationDom: conversationId.domain,
        },
      },
    });
    if (!row) return null;
    const raw = (row.raw as Record<string, unknown>) ?? {};
    return {
      conversationId: { id: row.conversationId, domain: row.conversationDom },
      timezone: row.timezone,
      locale: row.locale,
      secretMode: row.secretMode,
      implicitDetectionEnabled: raw.implicitDetectionEnabled as boolean | undefined,
      sensitivity: raw.sensitivity as ImplicitSensitivity | undefined,
      raw: row.raw ?? undefined,
    };
  }

  async upsert(config: ConversationConfig): Promise<ConversationConfig> {
    await this.prisma.conversationConfig.upsert({
      where: {
        conversationId_conversationDom: {
          conversationId: config.conversationId.id,
          conversationDom: config.conversationId.domain,
        },
      },
      create: {
        conversationId: config.conversationId.id,
        conversationDom: config.conversationId.domain,
        timezone: config.timezone,
        locale: config.locale,
        secretMode: config.secretMode ?? false,
        raw: config.raw as object | null ?? undefined,
      },
      update: {
        timezone: config.timezone,
        locale: config.locale,
        secretMode: config.secretMode ?? false,
        raw: config.raw as object | null ?? undefined,
      },
    });
    return config;
  }
}
