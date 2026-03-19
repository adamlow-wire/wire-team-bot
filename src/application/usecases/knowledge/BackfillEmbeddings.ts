import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { EmbeddingService } from "../../ports/EmbeddingPort";
import type { Logger } from "../../ports/Logger";

const BATCH_SIZE = 50;

/**
 * One-shot job that generates and persists embeddings for any KnowledgeEntry rows
 * that were created before the embedding column existed or before the embedding
 * service was configured.  Safe to run repeatedly — only processes missing embeddings.
 */
export class BackfillEmbeddings {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly embeddingService: EmbeddingService,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    let totalProcessed = 0;

    for (;;) {
      const entries = await this.knowledge.findMissingEmbeddings(BATCH_SIZE);
      if (entries.length === 0) break;

      const texts = entries.map((e) => `${e.summary}. ${e.detail}`);
      const embeddings = await this.embeddingService.embedBatch(texts);

      for (let i = 0; i < entries.length; i++) {
        const embedding = embeddings[i];
        if (embedding) {
          await this.knowledge.updateEmbedding(entries[i]!.id, embedding);
          totalProcessed++;
        }
      }

      if (entries.length < BATCH_SIZE) break;
    }

    if (totalProcessed > 0) {
      this.logger.info("Knowledge embedding backfill complete", { count: totalProcessed });
    }
  }
}
