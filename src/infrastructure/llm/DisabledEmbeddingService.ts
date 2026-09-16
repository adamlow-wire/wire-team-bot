import type { EmbeddingService } from "../../application/ports/EmbeddingPort";

/**
 * No-op EmbeddingService used when no embedding provider is configured (for example when
 * the chat provider is Anthropic, whose API has no /embeddings endpoint). Every consumer of
 * the port already treats `null` as "no vector available", so the pipeline, semantic
 * retrieval, entity dedup and contradiction detection degrade to skipping their vector
 * steps without logging a failure per message.
 */
export class DisabledEmbeddingService implements EmbeddingService {
  async embed(_text: string): Promise<number[] | null> {
    return null;
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map(() => null);
  }
}
