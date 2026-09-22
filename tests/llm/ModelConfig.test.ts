import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/app/config";

afterEach(() => vi.unstubAllEnvs());

it("loads model settings and fallbacks from the canonical environment prefix", () => {
  for (const [key, value] of Object.entries({
    WIRE_SDK_API_TOKEN: "synthetic-token", WIRE_SDK_API_HOST: "https://wire.invalid",
    WIRE_SDK_APP_ID: "test-bot", WIRE_SDK_APP_DOMAIN: "test.invalid", WIRE_SDK_CRYPTO_KEY: "01".repeat(32),
    WIRE_TEAM_BOT_LLM_BASE_URL: "https://model.invalid/v1/", WIRE_TEAM_BOT_LLM_API_KEY: "synthetic-key",
    WIRE_TEAM_BOT_EMBED_BASE_URL: "https://embed.invalid/v1", WIRE_TEAM_BOT_EMBED_API_KEY: "synthetic-embed-key",
    WIRE_TEAM_BOT_EMBEDDINGS: "off", WIRE_TEAM_BOT_LLM_TIMEOUT_MS: "12345",
  })) vi.stubEnv(key, value);
  const slots = { classify: "CLASSIFY", extract: "EXTRACT", embed: "EMBED", summarise: "SUMMARISE",
    queryAnalyse: "QUERY_ANALYSE", respond: "RESPOND", complexSynthesis: "COMPLEX" } as const;
  for (const suffix of Object.values(slots)) {
    vi.stubEnv(`WIRE_TEAM_BOT_MODEL_${suffix}`, `primary-${suffix}`);
    vi.stubEnv(`WIRE_TEAM_BOT_FALLBACK_${suffix}`, `fallback-${suffix}`);
  }
  const config = loadConfig().llm.bot;
  expect(config.baseUrl).toBe("https://model.invalid/v1");
  expect(config.apiKey).toBe("synthetic-key");
  expect(config.timeoutMs).toBe(12345);
  expect(config.embed).toEqual({ baseUrl: "https://embed.invalid/v1", apiKey: "synthetic-embed-key", enabled: false });
  for (const [key, suffix] of Object.entries(slots)) {
    expect(config.slots[key as keyof typeof slots]).toEqual({ model: `primary-${suffix}`, fallback: `fallback-${suffix}` });
  }
});
