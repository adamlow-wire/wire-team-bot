import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { LLMConfig } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { OpenAIEmbeddingAdapter } from "./OpenAIEmbeddingAdapter";
import { DisabledEmbeddingService } from "./DisabledEmbeddingService";

/**
 * Picks the embedding implementation from config. Logs once at startup when embeddings
 * are off so the degraded retrieval behaviour is visible without per-message noise.
 */
export function createEmbeddingService(config: LLMConfig, logger: Logger): EmbeddingService {
  if (!config.embed.enabled) {
    logger.warn(
      "Embeddings disabled: semantic retrieval and contradiction detection are off. " +
        "Point WIRE_TEAM_BOT_EMBED_BASE_URL at an OpenAI-compatible /embeddings provider, or set WIRE_TEAM_BOT_EMBEDDINGS=on to force.",
    );
    return new DisabledEmbeddingService();
  }
  if (config.embedDims !== 2560) throw new Error("Enabled embeddings must match the database vector(2560) column");
  return new OpenAIEmbeddingAdapter(config, logger);
}
