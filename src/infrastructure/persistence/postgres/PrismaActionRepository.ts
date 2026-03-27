import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository, ActionQuery } from "../../../domain/repositories/ActionRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { getPrismaClient } from "./PrismaClient";
import { nextEntityId } from "./PrismaIdGenerator";

function reminderAtToJson(dates: Date[]): string[] {
  return dates.map((d) => d.toISOString());
}

function reminderAtFromJson(json: unknown): Date[] {
  if (!Array.isArray(json)) return [];
  return json.map((s) => new Date(s as string));
}

export class PrismaActionRepository implements ActionRepository {
  private prisma = getPrismaClient();

  async nextId(): Promise<string> {
    return nextEntityId("action");
  }

  async create(action: Action): Promise<Action> {
    await this.prisma.action.create({
      data: {
        id: action.id,
        conversationId: action.conversationId.id,
        conversationDom: action.conversationId.domain,
        creatorId: action.creatorId.id,
        creatorDom: action.creatorId.domain,
        authorName: action.authorName,
        assigneeId: action.assigneeId.id,
        assigneeDom: action.assigneeId.domain,
        assigneeName: action.assigneeName,
        rawMessageId: action.rawMessageId,
        description: action.description,
        deadline: action.deadline,
        status: action.status,
        linkedIds: action.linkedIds,
        reminderAt: reminderAtToJson(action.reminderAt),
        completionNote: action.completionNote,
        tags: action.tags,
        timestamp: action.timestamp,
        updatedAt: action.updatedAt,
        deleted: action.deleted,
        version: action.version,
        // Phase 1a / Phase 2 fields
        stalenessAt: action.stalenessAt ?? null,
        lastStatusCheck: action.lastStatusCheck ?? null,
        actionConfidence: action.actionConfidence ?? null,
        relatedDecisionId: action.relatedDecisionId ?? null,
        sourceRef: action.sourceRef ? (action.sourceRef as object) : undefined,
        organisationId: action.organisationId ?? null,
        source: action.source ?? null,
        contentHash: action.contentHash ?? null,
        dismissedAt: action.dismissedAt ?? null,
        mergedIntoId: action.mergedIntoId ?? null,
      },
    });
    return action;
  }

  async update(action: Action): Promise<Action> {
    await this.prisma.action.update({
      where: { id: action.id },
      data: {
        description: action.description,
        assigneeId: action.assigneeId.id,
        assigneeDom: action.assigneeId.domain,
        assigneeName: action.assigneeName,
        deadline: action.deadline,
        status: action.status,
        linkedIds: action.linkedIds,
        reminderAt: reminderAtToJson(action.reminderAt),
        completionNote: action.completionNote,
        updatedAt: action.updatedAt,
        deleted: action.deleted,
        version: action.version,
      },
    });
    return action;
  }

  async findById(id: string): Promise<Action | null> {
    const row = await this.prisma.action.findUnique({ where: { id } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async findByContentHash(channelId: string, hash: string): Promise<Action | null> {
    const row = await this.prisma.action.findFirst({
      where: { conversationId: channelId, contentHash: hash, deleted: false },
    });
    return row ? this.fromRow(row) : null;
  }

  async query(criteria: ActionQuery): Promise<Action[]> {
    const where: Record<string, unknown> = {};
    if (criteria.conversationId) {
      where.conversationId = criteria.conversationId.id;
      where.conversationDom = criteria.conversationId.domain;
    }
    if (criteria.assigneeId) {
      where.assigneeId = criteria.assigneeId.id;
      where.assigneeDom = criteria.assigneeId.domain;
    }
    if (criteria.creatorId) {
      where.creatorId = criteria.creatorId.id;
      where.creatorDom = criteria.creatorId.domain;
    }
    if (criteria.statusIn && criteria.statusIn.length > 0) {
      where.status = { in: criteria.statusIn };
    }
    if (criteria.searchText) {
      where.description = { contains: criteria.searchText, mode: "insensitive" };
    }
    if (criteria.deadlineBefore != null) {
      where.deadline = { lt: criteria.deadlineBefore };
    }
    const take = criteria.limit ?? 50;
    const rows = await this.prisma.action.findMany({ where, take, orderBy: { timestamp: "desc" } });
    return rows.map((r) => this.fromRow(r));
  }

  private fromRow(row: {
    id: string;
    conversationId: string;
    conversationDom: string;
    creatorId: string;
    creatorDom: string;
    authorName: string;
    assigneeId: string;
    assigneeDom: string;
    assigneeName: string;
    rawMessageId: string;
    description: string;
    deadline: Date | null;
    status: string;
    linkedIds: string[];
    reminderAt: unknown;
    completionNote: string | null;
    tags: string[];
    timestamp: Date;
    updatedAt: Date;
    deleted: boolean;
    version: number;
    stalenessAt?: Date | null;
    lastStatusCheck?: Date | null;
    actionConfidence?: number | null;
    relatedDecisionId?: string | null;
    sourceRef?: unknown;
    organisationId?: string | null;
    source?: string | null;
    contentHash?: string | null;
    dismissedAt?: Date | null;
    mergedIntoId?: string | null;
  }): Action {
    return {
      id: row.id,
      conversationId: { id: row.conversationId, domain: row.conversationDom },
      creatorId: { id: row.creatorId, domain: row.creatorDom },
      assigneeId: { id: row.assigneeId, domain: row.assigneeDom },
      authorName: row.authorName,
      assigneeName: row.assigneeName,
      rawMessageId: row.rawMessageId,
      description: row.description,
      deadline: row.deadline,
      status: row.status as Action["status"],
      linkedIds: row.linkedIds,
      reminderAt: reminderAtFromJson(row.reminderAt),
      completionNote: row.completionNote,
      tags: row.tags,
      timestamp: row.timestamp,
      updatedAt: row.updatedAt,
      deleted: row.deleted,
      version: row.version,
      stalenessAt: row.stalenessAt ?? undefined,
      lastStatusCheck: row.lastStatusCheck ?? undefined,
      actionConfidence: row.actionConfidence ?? undefined,
      relatedDecisionId: row.relatedDecisionId ?? undefined,
      sourceRef: row.sourceRef ? (row.sourceRef as Action["sourceRef"]) : undefined,
      organisationId: row.organisationId ?? undefined,
      source: row.source ?? undefined,
      contentHash: row.contentHash ?? undefined,
      dismissedAt: row.dismissedAt ?? undefined,
      mergedIntoId: row.mergedIntoId ?? undefined,
    };
  }
}
