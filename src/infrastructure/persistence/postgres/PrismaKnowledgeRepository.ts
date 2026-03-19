import type {
  KnowledgeEntry,
  KnowledgeVerifiedBy,
} from "../../../domain/entities/KnowledgeEntry";
import type {
  KnowledgeRepository,
  KnowledgeQuery,
} from "../../../domain/repositories/KnowledgeRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "./PrismaClient";
import { nextEntityId } from "./PrismaIdGenerator";

/**
 * Returns true when the error indicates that pgvector is not installed or the
 * embedding column has not yet been migrated. In those cases callers should
 * degrade gracefully instead of propagating the error.
 */
function isPgvectorMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('type "vector" does not exist') ||
    msg.includes("could not open extension control file") ||
    msg.includes("column \"embedding\" does not exist") ||
    msg.includes("operator does not exist") && msg.includes("vector")
  );
}

function verifiedByToJson(arr: KnowledgeVerifiedBy[]): Prisma.InputJsonValue {
  return arr.map((v) => ({
    userId: { id: v.userId.id, domain: v.userId.domain },
    timestamp: v.timestamp.toISOString(),
  })) as Prisma.InputJsonValue;
}

function verifiedByFromJson(json: unknown): KnowledgeVerifiedBy[] {
  if (!Array.isArray(json)) return [];
  return json.map((v: { userId: { id: string; domain: string }; timestamp: string }) => ({
    userId: { id: v.userId.id, domain: v.userId.domain },
    timestamp: new Date(v.timestamp),
  }));
}

export class PrismaKnowledgeRepository implements KnowledgeRepository {
  private prisma = getPrismaClient();

  async nextId(): Promise<string> {
    return nextEntityId("knowledge");
  }

  async create(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    await this.prisma.knowledgeEntry.create({
      data: {
        id: entry.id,
        conversationId: entry.conversationId.id,
        conversationDom: entry.conversationId.domain,
        authorId: entry.authorId.id,
        authorDom: entry.authorId.domain,
        authorName: entry.authorName,
        rawMessageId: entry.rawMessageId,
        rawMessage: entry.rawMessage,
        summary: entry.summary,
        detail: entry.detail,
        category: entry.category,
        confidence: entry.confidence,
        relatedIds: entry.relatedIds,
        ttlDays: entry.ttlDays,
        verifiedBy: verifiedByToJson(entry.verifiedBy),
        retrievalCount: entry.retrievalCount,
        lastRetrieved: entry.lastRetrieved,
        tags: entry.tags,
        timestamp: entry.timestamp,
        updatedAt: entry.updatedAt,
        deleted: entry.deleted,
        version: entry.version,
      },
    });
    return entry;
  }

  async update(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    await this.prisma.knowledgeEntry.update({
      where: { id: entry.id },
      data: {
        summary: entry.summary,
        detail: entry.detail,
        category: entry.category,
        confidence: entry.confidence,
        relatedIds: entry.relatedIds,
        ttlDays: entry.ttlDays,
        verifiedBy: verifiedByToJson(entry.verifiedBy),
        retrievalCount: entry.retrievalCount,
        lastRetrieved: entry.lastRetrieved,
        tags: entry.tags,
        updatedAt: entry.updatedAt,
        deleted: entry.deleted,
        version: entry.version,
      },
    });
    return entry;
  }

  async findById(id: string): Promise<KnowledgeEntry | null> {
    const row = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    if (!row) return null;
    return this.fromRow(row);
  }

  async findByIds(ids: string[]): Promise<KnowledgeEntry[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { id: { in: ids }, deleted: false },
    });
    return rows.map((r) => this.fromRow(r));
  }

  async incrementRetrievalCount(id: string): Promise<void> {
    await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { retrievalCount: { increment: 1 }, lastRetrieved: new Date() },
    });
  }

  async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const vectorLiteral = `[${embedding.map((n) => n.toFixed(8)).join(",")}]`;
    await this.prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeEntry" SET embedding = $1::vector WHERE id = $2`,
      vectorLiteral,
      id,
    );
  }

  async findMissingEmbeddings(limit: number): Promise<Array<{ id: string; summary: string; detail: string }>> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; summary: string; detail: string }>>`
        SELECT id, summary, detail
        FROM "KnowledgeEntry"
        WHERE deleted = false AND embedding IS NULL
        ORDER BY timestamp ASC
        LIMIT ${limit}
      `;
      return rows;
    } catch (err) {
      if (isPgvectorMissingError(err)) {
        console.warn("[KnowledgeRepository] pgvector extension not available — embedding backfill disabled. Run the migration or install pgvector to enable semantic search.");
        return [];
      }
      throw err;
    }
  }

  async findByEmbedding(
    embedding: number[],
    conversationIds: QualifiedId[],
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    if (conversationIds.length === 0) return [];
    try {
      const vectorLiteral = `[${embedding.map((n) => n.toFixed(8)).join(",")}]`;
      const convIdValues = conversationIds.map((c) => c.id);
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; score: number }>>(
        `SELECT id, (1 - (embedding <=> $1::vector))::float AS score
         FROM "KnowledgeEntry"
         WHERE deleted = false
           AND "conversationId" = ANY($2::text[])
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        vectorLiteral,
        convIdValues,
        limit,
      );
      return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
    } catch (err) {
      if (isPgvectorMissingError(err)) {
        console.warn("[KnowledgeRepository] pgvector extension not available — semantic search disabled. Falling back to keyword-only search.");
        return [];
      }
      throw err;
    }
  }

  async query(criteria: KnowledgeQuery): Promise<KnowledgeEntry[]> {
    const where: Record<string, unknown> = {};
    if (criteria.conversationId) {
      where.conversationId = criteria.conversationId.id;
      where.conversationDom = criteria.conversationId.domain;
    }
    if (criteria.authorId) {
      where.authorId = criteria.authorId.id;
      where.authorDom = criteria.authorId.domain;
    }
    if (criteria.searchText) {
      // Split into individual tokens so "how many users does schwarz have" matches
      // entries containing "schwarz" or "users" rather than requiring the whole phrase.
      const terms = criteria.searchText
        .split(/\s+/)
        .map((t) => t.replace(/[?!.,;:'"]/g, ""))
        .filter((t) => t.length > 2);
      const searchClauses = (terms.length > 0 ? terms : [criteria.searchText]).flatMap((term) => [
        { summary: { contains: term, mode: "insensitive" as const } },
        { detail: { contains: term, mode: "insensitive" as const } },
      ]);
      where.OR = searchClauses;
    }
    if (criteria.tagsAll && criteria.tagsAll.length > 0) {
      where.tags = { hasEvery: criteria.tagsAll };
    }
    if (criteria.tagsAny && criteria.tagsAny.length > 0) {
      where.tags = { hasSome: criteria.tagsAny };
    }
    where.deleted = false;
    const take = criteria.limit ?? 50;
    const rows = await this.prisma.knowledgeEntry.findMany({
      where,
      take,
      orderBy: { updatedAt: "desc" },
    });
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
    detail: string;
    category: string;
    confidence: string;
    relatedIds: string[];
    ttlDays: number | null;
    verifiedBy: unknown;
    retrievalCount: number;
    lastRetrieved: Date | null;
    tags: string[];
    timestamp: Date;
    updatedAt: Date;
    deleted: boolean;
    version: number;
  }): KnowledgeEntry {
    const convId: QualifiedId = { id: row.conversationId, domain: row.conversationDom };
    const authorId: QualifiedId = { id: row.authorId, domain: row.authorDom };
    return {
      id: row.id,
      summary: row.summary,
      detail: row.detail,
      rawMessage: row.rawMessage,
      rawMessageId: row.rawMessageId,
      authorId,
      authorName: row.authorName,
      conversationId: convId,
      category: row.category as KnowledgeEntry["category"],
      confidence: row.confidence as KnowledgeEntry["confidence"],
      relatedIds: row.relatedIds,
      ttlDays: row.ttlDays,
      verifiedBy: verifiedByFromJson(row.verifiedBy),
      retrievalCount: row.retrievalCount,
      lastRetrieved: row.lastRetrieved,
      tags: row.tags,
      timestamp: row.timestamp,
      updatedAt: row.updatedAt,
      deleted: row.deleted,
      version: row.version,
    };
  }
}
