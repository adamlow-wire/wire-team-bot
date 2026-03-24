import type { Reminder, ReminderStatus } from "../../../domain/entities/Reminder";
import type {
  ReminderRepository,
  ReminderQuery,
} from "../../../domain/repositories/ReminderRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";
import { nextEntityId } from "./PrismaIdGenerator";

function toQualifiedId(id: string, domain: string): QualifiedId {
  return { id, domain };
}

const PLACEHOLDER_CONV: QualifiedId = { id: "", domain: "" };

export class PrismaReminderRepository implements ReminderRepository {
  private prisma = getPrismaClient();

  async nextId(): Promise<string> {
    return nextEntityId("reminder");
  }

  async create(reminder: Reminder): Promise<Reminder> {
    await this.prisma.reminder.create({
      data: {
        id: reminder.id,
        conversationId: reminder.conversationId?.id ?? null,
        conversationDom: reminder.conversationId?.domain ?? null,
        authorId: reminder.authorId.id,
        authorDom: reminder.authorId.domain,
        authorName: reminder.authorName,
        rawMessageId: reminder.rawMessageId,
        timestamp: reminder.timestamp,
        updatedAt: reminder.updatedAt,
        tags: reminder.tags,
        status: reminder.status,
        deleted: reminder.deleted,
        version: reminder.version,
        description: reminder.description,
        targetId: reminder.targetId.id,
        targetDom: reminder.targetId.domain,
        triggerAt: reminder.triggerAt,
        recurrence: reminder.recurrence ?? null,
        linkedIds: reminder.linkedIds,
      },
    });
    return reminder;
  }

  async update(reminder: Reminder): Promise<Reminder> {
    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: reminder.status,
        triggerAt: reminder.triggerAt,
        updatedAt: reminder.updatedAt,
        version: reminder.version,
      },
    });
    return reminder;
  }

  async findById(id: string): Promise<Reminder | null> {
    const row = await this.prisma.reminder.findUnique({ where: { id } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async query(criteria: ReminderQuery): Promise<Reminder[]> {
    const where: Record<string, unknown> = {};
    if (criteria.conversationId != null) {
      where.conversationId = criteria.conversationId.id;
      where.conversationDom = criteria.conversationId.domain;
    }
    if (criteria.targetId) {
      where.targetId = criteria.targetId.id;
      where.targetDom = criteria.targetId.domain;
    }
    if (criteria.statusIn?.length) {
      where.status = { in: criteria.statusIn };
    }
    if (criteria.dueBefore != null || criteria.dueAfter != null) {
      where.triggerAt = {};
      if (criteria.dueBefore != null) {
        (where.triggerAt as Record<string, Date>).lte = criteria.dueBefore;
      }
      if (criteria.dueAfter != null) {
        (where.triggerAt as Record<string, Date>).gte = criteria.dueAfter;
      }
    }
    const rows = await this.prisma.reminder.findMany({ where });
    return rows.map((r) => this.fromRow(r));
  }

  private fromRow(row: {
    id: string;
    conversationId: string | null;
    conversationDom: string | null;
    authorId: string;
    authorDom: string;
    authorName: string;
    rawMessageId: string;
    timestamp: Date;
    updatedAt: Date;
    tags: string[];
    status: string;
    deleted: boolean;
    version: number;
    description: string;
    targetId: string;
    targetDom: string;
    triggerAt: Date;
    recurrence: string | null;
    linkedIds: string[];
  }): Reminder {
    const conversationId =
      row.conversationId != null && row.conversationDom != null
        ? toQualifiedId(row.conversationId, row.conversationDom)
        : PLACEHOLDER_CONV;
    return {
      id: row.id,
      conversationId,
      authorId: toQualifiedId(row.authorId, row.authorDom),
      authorName: row.authorName,
      rawMessageId: row.rawMessageId,
      timestamp: row.timestamp,
      updatedAt: row.updatedAt,
      tags: row.tags,
      status: row.status as ReminderStatus,
      deleted: row.deleted,
      version: row.version,
      description: row.description,
      targetId: toQualifiedId(row.targetId, row.targetDom),
      triggerAt: row.triggerAt,
      recurrence: row.recurrence ?? null,
      linkedIds: row.linkedIds,
      createdAt: row.timestamp,
    };
  }
}
