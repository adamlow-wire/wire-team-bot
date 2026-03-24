import type {
  EmbeddingRepository,
  StoreEmbeddingParams,
  SimilarEmbedding,
  EmbeddingSourceType,
} from "../../../domain/repositories/EmbeddingRepository";
import { getPrismaClient } from "./PrismaClient";
import type { Logger } from "../../../application/ports/Logger";

export class PrismaEmbeddingRepository implements EmbeddingRepository {
  private readonly prisma = getPrismaClient();

  constructor(private readonly logger: Logger) {}

  async store(params: StoreEmbeddingParams): Promise<string> {
    // The `embedding` vector column is managed via raw SQL (not in the Prisma model).
    // We insert the row via $executeRaw and return the generated ID.
    const vecLiteral = `[${params.embedding.join(",")}]`;

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO embeddings (
        id, source_type, source_id, channel_id, organisation_id,
        author_id, created_at, topic_tags, embedding
      ) VALUES (
        gen_random_uuid(),
        ${params.sourceType},
        ${params.sourceId ?? null},
        ${params.channelId},
        ${params.orgId},
        ${params.authorId ?? null},
        ${params.createdAt},
        ${params.topicTags}::text[],
        ${vecLiteral}::vector
      )
      RETURNING id
    `;

    const id = rows[0]?.id;
    if (!id) throw new Error("PrismaEmbeddingRepository.store: no id returned");
    return id;
  }

  async findSimilar(
    channelId: string,
    embedding: number[],
    limit: number,
    sourceType?: EmbeddingSourceType,
  ): Promise<SimilarEmbedding[]> {
    const vecLiteral = `[${embedding.join(",")}]`;

    try {
      if (sourceType) {
        const rows = await this.prisma.$queryRaw<
          Array<{ id: string; source_id: string | null; source_type: string; similarity: number }>
        >`
          SELECT id, source_id, source_type,
                 1 - (embedding <=> ${vecLiteral}::vector) AS similarity
          FROM embeddings
          WHERE channel_id = ${channelId}
            AND source_type = ${sourceType}
          ORDER BY embedding <=> ${vecLiteral}::vector
          LIMIT ${limit}
        `;
        return rows.map(toSimilarEmbedding);
      }

      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; source_id: string | null; source_type: string; similarity: number }>
      >`
        SELECT id, source_id, source_type,
               1 - (embedding <=> ${vecLiteral}::vector) AS similarity
        FROM embeddings
        WHERE channel_id = ${channelId}
        ORDER BY embedding <=> ${vecLiteral}::vector
        LIMIT ${limit}
      `;
      return rows.map(toSimilarEmbedding);
    } catch (err) {
      this.logger.warn("EmbeddingRepository.findSimilar failed", { channelId, err: String(err) });
      return [];
    }
  }
}

function toSimilarEmbedding(row: {
  id: string;
  source_id: string | null;
  source_type: string;
  similarity: number;
}): SimilarEmbedding {
  return {
    id: row.id,
    sourceId: row.source_id ?? undefined,
    sourceType: row.source_type as EmbeddingSourceType,
    similarity: typeof row.similarity === "number" ? row.similarity : 0,
  };
}
