import type { KnowledgeEntry } from "../entities/KnowledgeEntry";
import type { QualifiedId } from "../ids/QualifiedId";

export interface KnowledgeQuery {
  conversationId?: QualifiedId;
  authorId?: QualifiedId;
  searchText?: string;
  tagsAll?: string[];
  tagsAny?: string[];
  limit?: number;
}

export interface KnowledgeRepository {
  create(entry: KnowledgeEntry): Promise<KnowledgeEntry>;
  update(entry: KnowledgeEntry): Promise<KnowledgeEntry>;
  findById(id: string): Promise<KnowledgeEntry | null>;
  findByIds(ids: string[]): Promise<KnowledgeEntry[]>;
  query(criteria: KnowledgeQuery): Promise<KnowledgeEntry[]>;
  nextId(): Promise<string>;
  /** Increment retrieval count and set lastRetrieved for a single entry (avoids N+1). */
  incrementRetrievalCount(id: string): Promise<void>;
  /** Persist a vector embedding for a knowledge entry. */
  updateEmbedding(id: string, embedding: number[]): Promise<void>;
  /** Return entries that are not yet embedded, ordered oldest-first. */
  findMissingEmbeddings(limit: number): Promise<Array<{ id: string; summary: string; detail: string }>>;
  /** Cosine-similarity search. Returns entry IDs with scores (0–1), ordered by similarity desc. */
  findByEmbedding(embedding: number[], conversationIds: QualifiedId[], limit: number): Promise<Array<{ id: string; score: number }>>;
}
