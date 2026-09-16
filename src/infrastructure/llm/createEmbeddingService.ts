import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { JeevesLLMConfig } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { JeevesEmbeddingAdapter } from "./JeevesEmbeddingAdapter";
import { DisabledEmbeddingService } from "./DisabledEmbeddingService";

/**
 * Picks the embedding implementation from config. Logs once at startup when embeddings
 * are off so the degraded retrieval behaviour is visible without per-message noise.
 */
export function createEmbeddingService(config: JeevesLLMConfig, logger: Logger): EmbeddingService {
  if (!config.embed.enabled) {
    logger.warn(
      "Embeddings disabled: semantic retrieval, entity dedup and contradiction detection are off. " +
        "Point JEEVES_EMBED_BASE_URL at an OpenAI-compatible /embeddings provider, or set JEEVES_EMBEDDINGS=on to force.",
    );
    return new DisabledEmbeddingService();
  }
  return new JeevesEmbeddingAdapter(config, logger);
}
