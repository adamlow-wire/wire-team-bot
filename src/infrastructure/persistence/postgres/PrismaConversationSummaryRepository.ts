import type {
  ConversationSummaryRepository,
  NewConversationSummary,
} from "../../../domain/repositories/ConversationSummaryRepository";
import type { ConversationSummary, SummaryGranularity } from "../../../domain/entities/ConversationSummary";
import { getPrismaClient } from "./PrismaClient";

export class PrismaConversationSummaryRepository implements ConversationSummaryRepository {
  private readonly prisma = getPrismaClient();

  async save(s: NewConversationSummary): Promise<ConversationSummary> {
    const row = await this.prisma.conversationSummary.upsert({
      where: {
        scopeType_scopeId_granularity_periodStart: {
          scopeType: s.scopeType,
          scopeId: s.scopeId,
          granularity: s.granularity,
          periodStart: s.periodStart,
        },
      },
      create: {
        scopeType: s.scopeType,
        scopeId: s.scopeId,
        organisationId: s.organisationId,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        granularity: s.granularity,
        summary: s.summary,
        keyDecisions: s.keyDecisions,
        keyActions: s.keyActions,
        activeTopics: s.activeTopics,
        participants: s.participants,
        sentiment: s.sentiment ?? null,
        messageCount: s.messageCount ?? null,
        modelVersion: s.modelVersion ?? null,
      },
      update: {
        periodEnd: s.periodEnd,
        summary: s.summary,
        keyDecisions: s.keyDecisions,
        keyActions: s.keyActions,
        activeTopics: s.activeTopics,
        participants: s.participants,
        sentiment: s.sentiment ?? null,
        messageCount: s.messageCount ?? null,
        modelVersion: s.modelVersion ?? null,
        generatedAt: new Date(),
      },
    });

    return fromRow(row);
  }

  async findLatest(channelId: string, granularity: SummaryGranularity): Promise<ConversationSummary | null> {
    const row = await this.prisma.conversationSummary.findFirst({
      where: { scopeType: "channel", scopeId: channelId, granularity },
      orderBy: { periodStart: "desc" },
    });
    return row ? fromRow(row) : null;
  }

  async findForPeriod(channelId: string, start: Date, end: Date): Promise<ConversationSummary[]> {
    const rows = await this.prisma.conversationSummary.findMany({
      where: {
        scopeType: "channel",
        scopeId: channelId,
        periodStart: { gte: start },
        periodEnd: { lte: end },
      },
      orderBy: { periodStart: "asc" },
    });
    return rows.map(fromRow);
  }
}

function fromRow(row: {
  id: string;
  scopeType: string;
  scopeId: string;
  organisationId: string;
  periodStart: Date;
  periodEnd: Date;
  granularity: string;
  summary: string;
  keyDecisions: string[];
  keyActions: string[];
  activeTopics: string[];
  participants: string[];
  sentiment: string | null;
  messageCount: number | null;
  modelVersion: string | null;
  generatedAt: Date;
}): ConversationSummary {
  return {
    id: row.id,
    scopeType: row.scopeType as ConversationSummary["scopeType"],
    scopeId: row.scopeId,
    organisationId: row.organisationId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    granularity: row.granularity as SummaryGranularity,
    summary: row.summary,
    keyDecisions: row.keyDecisions,
    keyActions: row.keyActions,
    activeTopics: row.activeTopics,
    participants: row.participants,
    sentiment: (row.sentiment ?? undefined) as ConversationSummary["sentiment"],
    messageCount: row.messageCount ?? undefined,
    modelVersion: row.modelVersion ?? undefined,
    generatedAt: row.generatedAt,
  };
}
