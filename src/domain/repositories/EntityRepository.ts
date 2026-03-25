import type { ExtractedEntity, ExtractedRelationship } from "../../application/ports/ExtractionPort";

export interface EntityRecord {
  id: string;
  channelId: string;
  organisationId: string;
  entityType: string;
  name: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  firstSeen?: Date;
  lastMentioned?: Date;
  mentionCount: number;
}

export interface EntityRepository {
  /**
   * Upsert an entity with deduplication.
   * Dedup logic: case-insensitive name match OR alias match within same channel + entityType.
   * Match → update (merge aliases, increment mentionCount, update lastMentioned).
   * No match → insert.
   * Returns the entity ID (existing or new).
   */
  upsertWithDedup(
    entity: ExtractedEntity,
    channelId: string,
    orgId: string,
  ): Promise<string>;

  /**
   * Upsert a relationship between two entities (by their DB IDs).
   * The UNIQUE(source_id, target_id, relationship) constraint handles dedup;
   * on conflict: increment observationCount and update lastObserved.
   */
  upsertRelationship(
    sourceId: string,
    targetId: string,
    rel: Omit<ExtractedRelationship, "sourceName" | "targetName">,
  ): Promise<void>;

  /** Return all entity names for a channel (for the knownEntities hint to Tier 2). */
  listNames(channelId: string): Promise<string[]>;
}
