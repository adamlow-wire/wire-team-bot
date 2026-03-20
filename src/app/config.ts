/**
 * Strongly-typed runtime configuration. Built from environment variables.
 *
 * Split LLM model strategy
 * ─────────────────────────
 * The bot makes two conceptually different kinds of LLM call:
 *
 *   passive  – runs on every received message to classify intent, decide
 *              whether to respond, and detect knowledge worth capturing.
 *              Should be fast and cheap. Ideal candidate for a locally-hosted
 *              model (Ollama with Qwen3 8B, Gemma 3 4B, etc.) so that message
 *              content never leaves the company network.
 *
 *   capable  – reserved for operations that benefit from higher reasoning
 *              quality: complex summarisation, semantic search ranking, future
 *              multi-step planning, etc. May point at a cloud model (GPT-4o,
 *              Claude, Gemini) or a larger local model.
 *
 * Configure each tier independently via LLM_PASSIVE_* and LLM_CAPABLE_*
 * environment variables. If the passive variables are omitted, the capable
 * model is used for both tiers (backwards-compatible default).
 */

export interface LLMTierConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

export interface EmbeddingConfig {
  /** OpenAI-compatible model name (e.g. text-embedding-3-small, nomic-embed-text). */
  model: string;
  /** Vector dimensions — must match the model output (e.g. 1536 for text-embedding-3-small, 768 for nomic-embed-text). */
  dims: number;
  /** Re-uses the capable tier base URL and API key. */
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

/**
 * Per-slot model config for the v2.0 seven-slot LLM architecture.
 * Each slot has a primary model and a fallback; all share one provider endpoint.
 */
export interface JeevesModelSlot {
  model: string;
  fallback: string;
}

export interface JeevesLLMConfig {
  /** Shared provider endpoint for all model slots. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** Cosine similarity above which query escalates to complexSynthesis model. */
  complexityThreshold: number;
  /** Minimum LLM extraction confidence to persist a result. */
  extractConfidenceMin: number;
  /** Cosine similarity threshold for entity deduplication. */
  entityDedupThreshold: number;
  /** Cosine similarity threshold for decision contradiction detection. */
  contradictionThreshold: number;
  /** Vector dimensions for embedding model output. */
  embedDims: number;
  slots: {
    classify: JeevesModelSlot;
    extract: JeevesModelSlot;
    embed: JeevesModelSlot;
    summarise: JeevesModelSlot;
    queryAnalyse: JeevesModelSlot;
    respond: JeevesModelSlot;
    complexSynthesis: JeevesModelSlot;
  };
}

export interface Config {
  wire: {
    userEmail: string;
    userPassword: string;
    userId: string;
    userDomain: string;
    apiHost: string;
    cryptoPassword: string;
  };
  database: {
    url: string;
  };
  app: {
    logLevel: string;
    messageBufferSize: number;
    storageDir: string;
    /** Inactivity period in ms before the bot prompts to exit secret mode. Default 1800000 (30 min). */
    secretModeInactivityMs: number;
  };
  llm: {
    /** Passive tier: ambient listening, intent classification, capture detection. */
    passive: LLMTierConfig;
    /** Capable tier: reserved for higher-quality reasoning tasks. */
    capable: LLMTierConfig;
    /** v2.0 seven-slot config (JEEVES_* env vars). Coexists with legacy tiers during Phase 1. */
    jeeves: JeevesLLMConfig;
  };
  embedding: EmbeddingConfig;
}

const REQUIRED_WIRE = [
  "WIRE_SDK_USER_EMAIL",
  "WIRE_SDK_USER_PASSWORD",
  "WIRE_SDK_USER_ID",
  "WIRE_SDK_USER_DOMAIN",
  "WIRE_SDK_API_HOST",
  "WIRE_SDK_CRYPTO_PASSWORD",
] as const;

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseLLMTier(prefix: string, fallback?: LLMTierConfig): LLMTierConfig {
  const apiKey = process.env[`${prefix}_API_KEY`] ?? fallback?.apiKey ?? "";
  const baseUrl = process.env[`${prefix}_BASE_URL`] ?? fallback?.baseUrl ?? "https://api.openai.com/v1";
  const model = process.env[`${prefix}_MODEL`] ?? fallback?.model ?? "gpt-4o-mini";
  const provider = process.env[`${prefix}_PROVIDER`] ?? fallback?.provider ?? "openai";
  const enabledEnv = process.env[`${prefix}_ENABLED`];
  const enabled =
    enabledEnv !== "false" &&
    (enabledEnv === "true" || apiKey.length > 0 || baseUrl.includes("localhost") || baseUrl.includes("ollama"));
  return { provider, baseUrl, apiKey, model, enabled };
}

function envStr(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

function envFloat(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseFloat(raw);
  return isNaN(n) ? defaultVal : n;
}

function envInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultVal : n;
}

function loadJeevesConfig(capable: LLMTierConfig): JeevesLLMConfig {
  const baseUrl = envStr("JEEVES_LLM_BASE_URL", capable.baseUrl);
  const apiKey = envStr("JEEVES_LLM_API_KEY", capable.apiKey);
  const slot = (modelEnv: string, fallbackEnv: string, defaultModel: string, defaultFallback: string): JeevesModelSlot => ({
    model: envStr(modelEnv, defaultModel),
    fallback: envStr(fallbackEnv, defaultFallback),
  });
  return {
    baseUrl,
    apiKey,
    timeoutMs: envInt("JEEVES_LLM_TIMEOUT_MS", 60_000),
    complexityThreshold: envFloat("JEEVES_COMPLEXITY_THRESHOLD", 0.7),
    extractConfidenceMin: envFloat("JEEVES_EXTRACT_CONFIDENCE_MIN", 0.6),
    entityDedupThreshold: envFloat("JEEVES_ENTITY_DEDUP_THRESHOLD", 0.92),
    contradictionThreshold: envFloat("JEEVES_CONTRADICTION_THRESHOLD", 0.78),
    embedDims: envInt("JEEVES_EMBED_DIMS", 1024),
    slots: {
      classify:        slot("JEEVES_MODEL_CLASSIFY",       "JEEVES_FALLBACK_CLASSIFY",       "qwen3-2507:4b",        "qwen3:0.6b"),
      extract:         slot("JEEVES_MODEL_EXTRACT",        "JEEVES_FALLBACK_EXTRACT",        "qwen3-2507:30b-a3b",   "qwen3:14b"),
      embed:           slot("JEEVES_MODEL_EMBED",          "JEEVES_FALLBACK_EMBED",          "qwen3-embedding:4b",   "bge-m3:567m"),
      summarise:       slot("JEEVES_MODEL_SUMMARISE",      "JEEVES_FALLBACK_SUMMARISE",      "qwen3-2507:30b-a3b",   "qwen3:14b"),
      queryAnalyse:    slot("JEEVES_MODEL_QUERY_ANALYSE",  "JEEVES_FALLBACK_QUERY_ANALYSE",  "granite4-tiny-h:7b",   "qwen3-2507:4b"),
      respond:         slot("JEEVES_MODEL_RESPOND",        "JEEVES_FALLBACK_RESPOND",        "qwen3-2507:30b-a3b",   "qwen3:14b"),
      complexSynthesis:slot("JEEVES_MODEL_COMPLEX",        "JEEVES_FALLBACK_COMPLEX",        "qwen3-next:80b",       "qwen3-2507:30b-a3b"),
    },
  };
}

export function loadConfig(): Config {
  const wire = {
    userEmail: getEnv(REQUIRED_WIRE[0]),
    userPassword: getEnv(REQUIRED_WIRE[1]),
    userId: getEnv(REQUIRED_WIRE[2]),
    userDomain: getEnv(REQUIRED_WIRE[3]),
    apiHost: getEnv(REQUIRED_WIRE[4]),
    cryptoPassword: getEnv(REQUIRED_WIRE[5]),
  };

  const database = {
    url: process.env.DATABASE_URL ?? "postgres://wirebot:wirebot@localhost:5432/wire_team_bot",
  };

  const logLevel = process.env.LOG_LEVEL ?? "info";
  const messageBufferSize = Math.min(
    Math.max(1, parseInt(process.env.MESSAGE_BUFFER_SIZE ?? "50", 10)),
    500,
  );
  const storageDir = process.env.STORAGE_DIR ?? "storage";
  const secretModeInactivityMs = Math.max(60_000, parseInt(process.env.SECRET_MODE_INACTIVITY_MS ?? "1800000", 10));

  // Capable tier — primary config (also backward-compatible with legacy LLM_* vars)
  const capable = parseLLMTier("LLM_CAPABLE", parseLLMTier("LLM"));

  // Passive tier — falls back to capable config if LLM_PASSIVE_* not set
  const passive = parseLLMTier("LLM_PASSIVE", capable);

  // Embedding — shares base URL and API key with the capable tier by default.
  // Set LLM_EMBEDDING_MODEL and LLM_EMBEDDING_DIMS if your embedding model differs
  // from the capable LLM (e.g. text-embedding-3-small vs a chat model).
  const embeddingModel = process.env.LLM_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const embeddingDims = Math.max(1, parseInt(process.env.LLM_EMBEDDING_DIMS ?? "1536", 10));
  const embeddingEnabledEnv = process.env.LLM_EMBEDDING_ENABLED;
  const embeddingEnabled =
    embeddingEnabledEnv !== "false" &&
    (embeddingEnabledEnv === "true" || capable.enabled);

  const embedding: EmbeddingConfig = {
    model: embeddingModel,
    dims: embeddingDims,
    baseUrl: capable.baseUrl,
    apiKey: capable.apiKey,
    enabled: embeddingEnabled,
  };

  const jeeves = loadJeevesConfig(capable);

  return {
    wire,
    database,
    app: { logLevel, messageBufferSize, storageDir, secretModeInactivityMs },
    llm: { passive, capable, jeeves },
    embedding,
  };
}
