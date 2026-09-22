/**
 * Strongly-typed runtime configuration. Built from environment variables.
 * All LLM configuration uses the WIRE_TEAM_BOT_* env var family.
 * Set WIRE_TEAM_BOT_LLM_BASE_URL to a local Ollama endpoint to keep all inference on-premises.
 */

/**
 * Per-slot model config for the seven-slot LLM architecture.
 * Each slot has a primary model and a fallback; all share one provider endpoint.
 */
export interface ModelSlot {
  model: string;
  fallback: string;
}

/**
 * Embedding endpoint settings. Chat and embeddings may come from different providers:
 * Anthropic's OpenAI-compatible endpoint serves chat completions but has no /embeddings,
 * so a Claude deployment points WIRE_TEAM_BOT_EMBED_BASE_URL at Ollama/OpenAI/etc. or runs with
 * embeddings disabled (semantic retrieval, entity dedup and contradiction detection off).
 */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export type EmbeddingsMode = "on" | "off" | "auto";

/** Hostname of Anthropic's API; it exposes chat completions but no /embeddings endpoint. */
export const ANTHROPIC_API_HOST = "api.anthropic.com";

export interface LLMConfig {
  /** Chat-completions provider endpoint shared by all six chat slots. */
  baseUrl: string;
  apiKey: string;
  /** Embedding provider; defaults to the chat provider unless overridden. */
  embed: EmbeddingConfig;
  timeoutMs: number;
  /** Complexity score above which the respond slot escalates to complexSynthesis. */
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
    classify: ModelSlot;
    extract: ModelSlot;
    embed: ModelSlot;
    summarise: ModelSlot;
    queryAnalyse: ModelSlot;
    respond: ModelSlot;
    complexSynthesis: ModelSlot;
  };
}

export interface Config {
  wire: {
    /** App authentication token issued by the Wire backend for this application. */
    apiToken: string;
    apiHost: string;
    /** 32-byte key protecting the SDK's local CoreCrypto store (WIRE_SDK_CRYPTO_KEY, 64 hex chars). */
    cryptoKey: Uint8Array;
    /** Qualified ID of the application; verified against the backend at startup. */
    appId: string;
    appDomain: string;
  };
  database: {
    url: string;
  };
  app: {
    logLevel: string;
    messageBufferSize: number;
    /** Inactivity period in ms before the bot prompts to exit secret mode. Default 1800000 (30 min). */
    secretModeInactivityMs: number;
  };
  llm: {
    bot: LLMConfig;
  };
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const CRYPTO_KEY_BYTES = 32;

/**
 * Decode WIRE_SDK_CRYPTO_KEY: exactly 32 bytes, hex-encoded (64 chars).
 * Generate one with `openssl rand -hex 32`. Losing it means losing the crypto store.
 */
function parseCryptoKey(name: string): Uint8Array {
  const raw = getEnv(name).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be ${CRYPTO_KEY_BYTES} bytes hex-encoded (${CRYPTO_KEY_BYTES * 2} hex characters)`);
  }
  return new Uint8Array(Buffer.from(raw, "hex"));
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

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Pure resolver for the embedding endpoint, kept separate from process.env for testing.
 * `auto` disables embeddings only when the effective embedding host is Anthropic's API,
 * which has no /embeddings endpoint; any other host is assumed to serve one.
 */
export function resolveEmbeddingSettings(input: {
  llmBaseUrl: string;
  llmApiKey: string;
  embedBaseUrl?: string;
  embedApiKey?: string;
  mode: EmbeddingsMode;
}): EmbeddingConfig {
  const baseUrl = (input.embedBaseUrl?.trim() || input.llmBaseUrl).replace(/\/+$/, "");
  const apiKey = input.embedApiKey !== undefined ? input.embedApiKey : input.llmApiKey;
  const enabled =
    input.mode === "on" ? true
    : input.mode === "off" ? false
    : hostOf(baseUrl) !== ANTHROPIC_API_HOST;
  return { baseUrl, apiKey, enabled };
}

function envEmbeddingsMode(name: string): EmbeddingsMode {
  const raw = (process.env[name] ?? "auto").trim().toLowerCase();
  if (raw === "on" || raw === "off" || raw === "auto") return raw;
  throw new Error(`${name} must be one of: on, off, auto`);
}

function loadLLMConfig(): LLMConfig {
  const baseUrl = envStr("WIRE_TEAM_BOT_LLM_BASE_URL", "http://localhost:11434/v1").replace(/\/+$/, "");
  const apiKey = envStr("WIRE_TEAM_BOT_LLM_API_KEY", "");
  const embed = resolveEmbeddingSettings({
    llmBaseUrl: baseUrl,
    llmApiKey: apiKey,
    embedBaseUrl: process.env.WIRE_TEAM_BOT_EMBED_BASE_URL,
    embedApiKey: process.env.WIRE_TEAM_BOT_EMBED_API_KEY,
    mode: envEmbeddingsMode("WIRE_TEAM_BOT_EMBEDDINGS"),
  });
  const slot = (modelEnv: string, fallbackEnv: string, defaultModel: string, defaultFallback: string): ModelSlot => ({
    model: envStr(modelEnv, defaultModel),
    fallback: envStr(fallbackEnv, defaultFallback),
  });
  return {
    baseUrl,
    apiKey,
    embed,
    timeoutMs: envInt("WIRE_TEAM_BOT_LLM_TIMEOUT_MS", 60_000),
    complexityThreshold: envFloat("WIRE_TEAM_BOT_COMPLEXITY_THRESHOLD", 0.7),
    extractConfidenceMin: envFloat("WIRE_TEAM_BOT_EXTRACT_CONFIDENCE_MIN", 0.6),
    entityDedupThreshold: envFloat("WIRE_TEAM_BOT_ENTITY_DEDUP_THRESHOLD", 0.92),
    contradictionThreshold: envFloat("WIRE_TEAM_BOT_CONTRADICTION_THRESHOLD", 0.78),
    embedDims: envInt("WIRE_TEAM_BOT_EMBED_DIMS", 2560),
    slots: {
      classify:        slot("WIRE_TEAM_BOT_MODEL_CLASSIFY",       "WIRE_TEAM_BOT_FALLBACK_CLASSIFY",       "qwen3-next:80b",       "qwen3-next:80b"),
      extract:         slot("WIRE_TEAM_BOT_MODEL_EXTRACT",        "WIRE_TEAM_BOT_FALLBACK_EXTRACT",        "qwen3-next:80b",       "qwen3-next:80b"),
      embed:           slot("WIRE_TEAM_BOT_MODEL_EMBED",          "WIRE_TEAM_BOT_FALLBACK_EMBED",          "qwen3-embedding:4b",   "qwen3-embedding:4b"),
      summarise:       slot("WIRE_TEAM_BOT_MODEL_SUMMARISE",      "WIRE_TEAM_BOT_FALLBACK_SUMMARISE",      "qwen3-next:80b",       "qwen3-next:80b"),
      queryAnalyse:    slot("WIRE_TEAM_BOT_MODEL_QUERY_ANALYSE",  "WIRE_TEAM_BOT_FALLBACK_QUERY_ANALYSE",  "qwen3-next:80b",       "qwen3-next:80b"),
      respond:         slot("WIRE_TEAM_BOT_MODEL_RESPOND",        "WIRE_TEAM_BOT_FALLBACK_RESPOND",        "qwen3-next:80b",       "qwen3-next:80b"),
      complexSynthesis:slot("WIRE_TEAM_BOT_MODEL_COMPLEX",        "WIRE_TEAM_BOT_FALLBACK_COMPLEX",        "gpt-oss:120b",         "qwen3-next:80b"),
    },
  };
}

export function loadConfig(): Config {
  const wire = {
    apiToken: getEnv("WIRE_SDK_API_TOKEN"),
    apiHost: getEnv("WIRE_SDK_API_HOST"),
    cryptoKey: parseCryptoKey("WIRE_SDK_CRYPTO_KEY"),
    appId: getEnv("WIRE_SDK_APP_ID"),
    appDomain: getEnv("WIRE_SDK_APP_DOMAIN"),
  };

  const database = {
    url: process.env.DATABASE_URL ?? "postgres://wirebot:wirebot@localhost:5432/wire_team_bot",
  };

  const logLevel = process.env.LOG_LEVEL ?? "info";
  const messageBufferSize = Math.min(
    Math.max(1, parseInt(process.env.MESSAGE_BUFFER_SIZE ?? "50", 10)),
    500,
  );
  const secretModeInactivityMs = Math.max(60_000, parseInt(process.env.SECRET_MODE_INACTIVITY_MS ?? "1800000", 10));

  const bot = loadLLMConfig();

  return {
    wire,
    database,
    app: { logLevel, messageBufferSize, secretModeInactivityMs },
    llm: { bot },
  };
}
