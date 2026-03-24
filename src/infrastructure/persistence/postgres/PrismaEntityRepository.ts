import type { EntityRepository } from "../../../domain/repositories/EntityRepository";
import type { ExtractedEntity, ExtractedRelationship } from "../../../application/ports/ExtractionPort";
import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "./PrismaClient";

export class PrismaEntityRepository implements EntityRepository {
  private readonly prisma = getPrismaClient();

  async upsertWithDedup(
    entity: ExtractedEntity,
    channelId: string,
    orgId: string,
  ): Promise<string> {
    const nameLower = entity.name.toLowerCase().trim();

    // Dedup: look for exact name match or alias match within same channel + entity type.
    // At 0.92 cosine similarity threshold, names must be nearly identical — normalised
    // string equality is a correct proxy for this at MVP. pgvector similarity dedup
    // (using entity name embeddings) is a post-MVP enhancement.
    const candidates = await this.prisma.entity.findMany({
      where: {
        channelId,
        entityType: entity.entityType,
        deleted: false,
      },
      select: { id: true, name: true, aliases: true, mentionCount: true },
    });

    const match = candidates.find((c) => {
      const cName = c.name.toLowerCase().trim();
      if (cName === nameLower) return true;
      // Alias match
      const aliasLower = c.aliases.map((a) => a.toLowerCase().trim());
      if (aliasLower.includes(nameLower)) return true;
      // Check if new entity's aliases match the candidate name
      const newAliasesLower = entity.aliases.map((a) => a.toLowerCase().trim());
      if (newAliasesLower.includes(cName)) return true;
      return false;
    });

    const now = new Date();

    if (match) {
      // Merge aliases and increment mention count
      const existingAliases = new Set(
        [match.name, ...match.aliases].map((a) => a.toLowerCase().trim()),
      );
      const newAliases = [entity.name, ...entity.aliases].filter(
        (a) => !existingAliases.has(a.toLowerCase().trim()),
      );
      const mergedAliases = [
        ...match.aliases,
        ...newAliases,
      ];

      await this.prisma.entity.update({
        where: { id: match.id },
        data: {
          aliases: mergedAliases,
          mentionCount: match.mentionCount + 1,
          lastMentioned: now,
        },
      });

      return match.id;
    }

    // Insert new entity
    const created = await this.prisma.entity.create({
      data: {
        channelId,
        organisationId: orgId,
        entityType: entity.entityType,
        name: entity.name,
        aliases: entity.aliases,
        metadata: (entity.metadata ?? {}) as Prisma.InputJsonValue,
        firstSeen: now,
        lastMentioned: now,
        mentionCount: 1,
        deleted: false,
      },
    });

    return created.id;
  }

  async upsertRelationship(
    sourceId: string,
    targetId: string,
    rel: Omit<ExtractedRelationship, "sourceName" | "targetName">,
  ): Promise<void> {
    const now = new Date();

    // The UNIQUE(source_id, target_id, relationship) constraint handles dedup.
    // On conflict: increment observationCount and update lastObserved.
    await this.prisma.$executeRaw`
      INSERT INTO entity_relationships (
        id, source_id, target_id, relationship, context,
        confidence, first_observed, last_observed, observation_count
      ) VALUES (
        gen_random_uuid(), ${sourceId}::uuid, ${targetId}::uuid, ${rel.relationship},
        ${rel.context ?? null}, ${rel.confidence ?? 0.7},
        ${now}, ${now}, 1
      )
      ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
        last_observed = ${now},
        observation_count = entity_relationships.observation_count + 1,
        context = COALESCE(${rel.context ?? null}, entity_relationships.context)
    `;
  }

  async listNames(channelId: string): Promise<string[]> {
    const rows = await this.prisma.entity.findMany({
      where: { channelId, deleted: false },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }
}
