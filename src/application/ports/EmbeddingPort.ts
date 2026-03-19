export interface EmbeddingService {
  /** Embed a single text string. Returns null if the service is unavailable or the call fails. */
  embed(text: string): Promise<number[] | null>;
  /** Embed multiple texts in one API call. Null entries indicate individual failures. */
  embedBatch(texts: string[]): Promise<Array<number[] | null>>;
}
