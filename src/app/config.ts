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

  return {
    wire,
    database,
    app: { logLevel, messageBufferSize, storageDir, secretModeInactivityMs },
    llm: { passive, capable },
  };
}
