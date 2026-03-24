import type {
  ConversationSignalRepository,
  NewConversationSignal,
  ConversationSignalRecord,
} from "../../../domain/repositories/ConversationSignalRepository";
import { getPrismaClient } from "./PrismaClient";

export class PrismaConversationSignalRepository implements ConversationSignalRepository {
  private readonly prisma = getPrismaClient();

  async create(signal: NewConversationSignal): Promise<void> {
    await this.prisma.conversationSignal.create({
      data: {
        channelId: signal.channelId,
        organisationId: signal.orgId,
        signalType: signal.signalType,
        summary: signal.summary,
        participants: signal.participants,
        tags: signal.tags,
        occurredAt: signal.occurredAt,
        confidence: signal.confidence,
        sourceRef: signal.sourceRef as object,
      },
    });
  }

  async query(channelId: string, start: Date, end: Date): Promise<ConversationSignalRecord[]> {
    const rows = await this.prisma.conversationSignal.findMany({
      where: {
        channelId,
        occurredAt: { gte: start, lte: end },
      },
      orderBy: { occurredAt: "asc" },
      select: {
        id: true,
        channelId: true,
        organisationId: true,
        signalType: true,
        summary: true,
        participants: true,
        tags: true,
        occurredAt: true,
        confidence: true,
      },
    });
    return rows;
  }
}
