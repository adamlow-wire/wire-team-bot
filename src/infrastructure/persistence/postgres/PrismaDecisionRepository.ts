import type { Decision, DecisionContextItem, DecisionAttachment } from "../../../domain/entities/Decision";
import type { DecisionRepository, DecisionQuery } from "../../../domain/repositories/DecisionRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "./PrismaClient";
import { nextEntityId } from "./PrismaIdGenerator";

const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

function participantsToJson(participants: QualifiedId[]): unknown {
  return participants.map((p) => ({ id: p.id, domain: p.domain }));
}

function participantsFromJson(json: unknown): QualifiedId[] {
  if (!Array.isArray(json)) return [];
  return json.map((p: { id: string; domain: string }) => ({ id: p.id, domain: p.domain }));
}

export class PrismaDecisionRepository implements DecisionRepository {
  private prisma = getPrismaClient();

  async nextId(): Promise<string> {
    return nextEntityId("decision");
  }

  async create(decision: Decision): Promise<Decision> {
    await this.prisma.decision.create({
      data: {
        id: decision.id,
        conversationId: decision.conversationId.id,
        conversationDom: decision.conversationId.domain,
        authorId: decision.authorId.id,
        authorDom: decision.authorId.domain,
        authorName: decision.authorName,
        rawMessageId: decision.rawMessageId,
        rawMessage: decision.rawMessage,
        summary: decision.summary,
        context: toJson(decision.context),
        participants: toJson(participantsToJson(decision.participants)),
        status: decision.status,
        supersededBy: decision.supersededBy ?? null,
        supersedes: decision.supersedes ?? null,
        linkedIds: decision.linkedIds,
        attachments: toJson(decision.attachments),
        tags: decision.tags,
        timestamp: decision.timestamp,
        updatedAt: decision.updatedAt,
        deleted: decision.deleted,
        version: decision.version,
      },
    });
    return decision;
  }

  async update(decision: Decision): Promise<Decision> {
    await this.prisma.decision.update({
      where: { id: decision.id },
      data: {
        summary: decision.summary,
        context: toJson(decision.context),
        participants: toJson(participantsToJson(decision.participants)),
        status: decision.status,
        supersededBy: decision.supersededBy ?? null,
        supersedes: decision.supersedes ?? null,
        linkedIds: decision.linkedIds,
        attachments: toJson(decision.attachments),
        tags: decision.tags,
        updatedAt: decision.updatedAt,
        deleted: decision.deleted,
        version: decision.version,
      },
    });
    return decision;
  }

  async findById(id: string): Promise<Decision | null> {
    const row = await this.prisma.decision.findUnique({ where: { id } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async query(criteria: DecisionQuery): Promise<Decision[]> {
    const where: Record<string, unknown> = {};
    if (criteria.conversationId) {
      where.conversationId = criteria.conversationId.id;
      where.conversationDom = criteria.conversationId.domain;
    }
    if (criteria.authorId) {
      where.authorId = criteria.authorId.id;
      where.authorDom = criteria.authorId.domain;
    }
    if (criteria.statusIn && criteria.statusIn.length > 0) {
      where.status = { in: criteria.statusIn };
    }
    if (criteria.searchText) {
      where.summary = { contains: criteria.searchText, mode: "insensitive" };
    }
    const take = criteria.limit ?? 50;
    const rows = await this.prisma.decision.findMany({ where, take, orderBy: { timestamp: "desc" } });
    return rows.map((r) => this.fromRow(r));
  }

  private fromRow(row: {
    id: string;
    conversationId: string;
    conversationDom: string;
    authorId: string;
    authorDom: string;
    authorName: string;
    rawMessageId: string;
    rawMessage: string;
    summary: string;
    context: unknown;
    participants: unknown;
    status: string;
    supersededBy: string | null;
    supersedes: string | null;
    linkedIds: string[];
    attachments: unknown;
    tags: string[];
    timestamp: Date;
    updatedAt: Date;
    deleted: boolean;
    version: number;
  }): Decision {
    const context = (row.context as DecisionContextItem[]) ?? [];
    const attachments = (row.attachments as DecisionAttachment[]) ?? [];
    return {
      id: row.id,
      conversationId: { id: row.conversationId, domain: row.conversationDom },
      authorId: { id: row.authorId, domain: row.authorDom },
      authorName: row.authorName,
      rawMessageId: row.rawMessageId,
      rawMessage: row.rawMessage,
      summary: row.summary,
      context,
      participants: participantsFromJson(row.participants),
      status: row.status as Decision["status"],
      supersededBy: row.supersededBy,
      supersedes: row.supersedes,
      linkedIds: row.linkedIds,
      attachments,
      tags: row.tags,
      timestamp: row.timestamp,
      updatedAt: row.updatedAt,
      deleted: row.deleted,
      version: row.version,
    };
  }
}
