export type EmbeddingSourceType =
  | "decision"
  | "action"
  | "signal"
  | "summary"
  | "message";

export interface StoreEmbeddingParams {
  sourceType: EmbeddingSourceType;
  /** DB ID of the source record, if applicable. */
  sourceId?: string;
  channelId: string;
  orgId: string;
  /** Wire user ID of the message author, if known. */
  authorId?: string;
  /** When the source content occurred (NOT when the embedding was computed). */
  createdAt: Date;
  topicTags: string[];
  /** The embedding vector. Text is discarded by the caller after this is computed. */
  embedding: number[];
}

export interface SimilarEmbedding {
  id: string;
  sourceId?: string;
  sourceType: EmbeddingSourceType;
  /** Cosine similarity (0–1). Higher = more similar. */
  similarity: number;
}

export interface EmbeddingRepository {
  /** Store an embedding vector. Returns the new row ID. */
  store(params: StoreEmbeddingParams): Promise<string>;

  /**
   * Find the most similar embeddings in a channel using HNSW ANN search.
   * @param channelId   Scope to this channel.
   * @param embedding   Query vector.
   * @param limit       Maximum results.
   * @param sourceType  Optional filter by source type.
   */
  findSimilar(
    channelId: string,
    embedding: number[],
    limit: number,
    sourceType?: EmbeddingSourceType,
  ): Promise<SimilarEmbedding[]>;
}
