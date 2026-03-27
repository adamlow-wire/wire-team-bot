/**
 * Strongly-typed runtime configuration. Built from environment variables.
 * All LLM configuration uses the JEEVES_* env var family.
 * Set JEEVES_LLM_BASE_URL to a local Ollama endpoint to keep all inference on-premises.
 */

/**
 * Per-slot model config for the seven-slot LLM architecture.
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
  /** Complexity score above which the respond slot escalates to complexSynthesis. */
  complexityThreshold: number;
  /** Minimum LLM extraction confidence to persist a result. */
  extractConfidenceMin: number;
  /** Cosine similarity threshold for entity deduplication. */
  entityDedupThreshold: number;
  /** Cosine similarity threshold for decision contradiction detection. */
  contradictionThreshold: number;
  /** Cosine similarity threshold for write-time decision deduplication (default 0.85). */
  dedupSimilarityThreshold: number;
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
  redis: {
    /** Full Redis connection URL, e.g. redis://:password@redis:6379 */
    url: string;
  };
  app: {
    logLevel: string;
    messageBufferSize: number;
    storageDir: string;
    /** Inactivity period in ms before the bot prompts to exit secret mode. Default 1800000 (30 min). */
    secretModeInactivityMs: number;
    /** Configurable bot persona name. Defaults to "Jeeves". Used in all user-facing messages and LLM prompts. */
    botName: string;
    /** Path to jeeves-seed.yaml. Undefined = skip seeding silently. */
    seedFile: string | undefined;
  };
  llm: {
    jeeves: JeevesLLMConfig;
  };
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

function loadJeevesConfig(): JeevesLLMConfig {
  const baseUrl = envStr("JEEVES_LLM_BASE_URL", "http://localhost:11434/v1");
  const apiKey = envStr("JEEVES_LLM_API_KEY", "");
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
    dedupSimilarityThreshold: envFloat("JEEVES_DEDUP_SIMILARITY_THRESHOLD", 0.85),
    embedDims: envInt("JEEVES_EMBED_DIMS", 2560),
    slots: {
      classify:        slot("JEEVES_MODEL_CLASSIFY",       "JEEVES_FALLBACK_CLASSIFY",       "qwen3-next:80b",       "qwen3-next:80b"),
      extract:         slot("JEEVES_MODEL_EXTRACT",        "JEEVES_FALLBACK_EXTRACT",        "qwen3-next:80b",       "qwen3-next:80b"),
      embed:           slot("JEEVES_MODEL_EMBED",          "JEEVES_FALLBACK_EMBED",          "qwen3-embedding:4b",   "qwen3-embedding:4b"),
      summarise:       slot("JEEVES_MODEL_SUMMARISE",      "JEEVES_FALLBACK_SUMMARISE",      "qwen3-next:80b",       "qwen3-next:80b"),
      queryAnalyse:    slot("JEEVES_MODEL_QUERY_ANALYSE",  "JEEVES_FALLBACK_QUERY_ANALYSE",  "qwen3-next:80b",       "qwen3-next:80b"),
      respond:         slot("JEEVES_MODEL_RESPOND",        "JEEVES_FALLBACK_RESPOND",        "qwen3-next:80b",       "qwen3-next:80b"),
      complexSynthesis:slot("JEEVES_MODEL_COMPLEX",        "JEEVES_FALLBACK_COMPLEX",        "gpt-oss:120b",         "qwen3-next:80b"),
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

  const redis = {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  };

  const logLevel = process.env.LOG_LEVEL ?? "info";
  const messageBufferSize = Math.min(
    Math.max(1, parseInt(process.env.MESSAGE_BUFFER_SIZE ?? "50", 10)),
    500,
  );
  const storageDir = process.env.STORAGE_DIR ?? "storage";
  const secretModeInactivityMs = Math.max(60_000, parseInt(process.env.SECRET_MODE_INACTIVITY_MS ?? "1800000", 10));
  const botName = process.env.BOT_NAME ?? "Jeeves";
  const seedFile = process.env.JEEVES_SEED_FILE ?? undefined;

  const jeeves = loadJeevesConfig();

  return {
    wire,
    database,
    redis,
    app: { logLevel, messageBufferSize, storageDir, secretModeInactivityMs, botName, seedFile },
    llm: { jeeves },
  };
}
