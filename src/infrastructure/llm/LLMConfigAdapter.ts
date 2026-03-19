import type { Config, LLMTierConfig, EmbeddingConfig } from "../../app/config";

/**
 * Exposes LLM tier configuration for adapters, keeping infrastructure
 * isolated from the top-level Config shape.
 */
export type LLMConfig = LLMTierConfig;
export type { EmbeddingConfig };

/** Config for the passive (ambient listening) model tier. */
export function getPassiveLLMConfig(config: Config): LLMConfig {
  return { ...config.llm.passive };
}

/** Config for the capable (higher-quality reasoning) model tier. */
export function getCapableLLMConfig(config: Config): LLMConfig {
  return { ...config.llm.capable };
}

/** @deprecated Use getPassiveLLMConfig or getCapableLLMConfig. */
export function getLLMConfig(config: Config): LLMConfig {
  return getCapableLLMConfig(config);
}

/** Config for the embedding model (shares base URL / API key with the capable tier). */
export function getEmbeddingConfig(config: Config): EmbeddingConfig {
  return { ...config.embedding };
}
