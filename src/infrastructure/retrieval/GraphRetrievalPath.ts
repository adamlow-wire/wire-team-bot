/**
 * Graph retrieval path — BFS traversal on entity_relationships (depth ≤ 3).
 * Starting from entities mentioned in the query plan, expands outward through
 * the relationship graph and returns entities + relationships as context snippets.
 * Falls back to empty results on any error.
 */

import type { RetrievalResult, RetrievalScope } from "../../application/ports/RetrievalPort";
import type { QueryPlan } from "../../application/ports/QueryAnalysisPort";
import type { Logger } from "../../application/ports/Logger";
import { getPrismaClient } from "../persistence/postgres/PrismaClient";

const MAX_DEPTH = 3;
const MAX_ENTITIES = 15;

interface EntityRow {
  id: string;
  name: string;
  entity_type: string;
  channel_id: string;
  mention_count: number;
}

interface RelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  context: string | null;
  confidence: number;
  observation_count: number;
  source_name?: string;
  target_name?: string;
}

export class GraphRetrievalPath {
  private readonly prisma = getPrismaClient();

  constructor(private readonly logger: Logger) {}

  async retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]> {
    if (!scope.channelId || plan.entities.length === 0) return [];

    try {
      return await this.bfsTraversal(plan.entities, scope.channelId);
    } catch (err) {
      this.logger.warn("GraphRetrievalPath: traversal failed", { err: String(err) });
      return [];
    }
  }

  private async bfsTraversal(entityNames: string[], channelId: string): Promise<RetrievalResult[]> {
    // Step 1: seed entities by name match (case-insensitive)
    const nameLower = entityNames.map((n) => n.toLowerCase());
    const seedEntities = await this.prisma.$queryRaw<EntityRow[]>`
      SELECT id, name, entity_type, channel_id, mention_count
      FROM entities
      WHERE channel_id = ${channelId}
        AND deleted = false
        AND lower(name) = ANY(${nameLower}::text[])
      LIMIT 10
    `;

    if (seedEntities.length === 0) return [];

    // BFS
    const visited = new Set<string>(seedEntities.map((e) => e.id));
    const queue = [...seedEntities.map((e) => e.id)];
    const allRelationships: RelationshipRow[] = [];
    let depth = 0;

    while (queue.length > 0 && depth < MAX_DEPTH && visited.size < MAX_ENTITIES) {
      depth++;
      const currentBatch = [...queue];
      queue.length = 0;

      const rels = await this.prisma.$queryRaw<RelationshipRow[]>`
        SELECT
          er.id, er.source_id, er.target_id, er.relationship,
          er.context, er.confidence, er.observation_count,
          se.name AS source_name, te.name AS target_name
        FROM entity_relationships er
        JOIN entities se ON se.id = er.source_id
        JOIN entities te ON te.id = er.target_id
        WHERE (er.source_id = ANY(${currentBatch}::uuid[])
           OR  er.target_id = ANY(${currentBatch}::uuid[]))
          AND se.channel_id = ${channelId}
          AND te.channel_id = ${channelId}
          AND se.deleted = false
          AND te.deleted = false
        ORDER BY er.observation_count DESC
        LIMIT 50
      `;

      for (const rel of rels) {
        allRelationships.push(rel);
        const otherId = currentBatch.includes(rel.source_id) ? rel.target_id : rel.source_id;
        if (!visited.has(otherId)) {
          visited.add(otherId);
          queue.push(otherId);
        }
      }
    }

    if (allRelationships.length === 0) return [];

    // Deduplicate relationship rows by id
    const seen = new Set<string>();
    const unique = allRelationships.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Convert to RetrievalResults
    const now = new Date();
    return unique.slice(0, MAX_ENTITIES).map((rel) => {
      const src = rel.source_name ?? rel.source_id;
      const tgt = rel.target_name ?? rel.target_id;
      const ctx = rel.context ? ` (${rel.context})` : "";
      const content = `Entity relationship: ${src} ${rel.relationship} ${tgt}${ctx} [seen ${rel.observation_count}×]`;

      return {
        id: rel.id,
        type: "entity" as const,
        content,
        sourceChannel: channelId,
        sourceDate: now,
        confidence: rel.confidence,
        pathsMatched: ["graph"],
      };
    });
  }
}
