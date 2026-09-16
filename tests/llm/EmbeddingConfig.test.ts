/**
 * Embedding provider selection.
 *
 * Chat and embeddings can come from different providers. Anthropic's OpenAI-compatible
 * endpoint has no /embeddings, so a Claude-only deployment must either point the embed
 * slot elsewhere or run with embeddings disabled. These tests pin that resolution logic
 * and the no-op service the bot falls back to.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveEmbeddingSettings, type JeevesLLMConfig } from "../../src/app/config";
import { DisabledEmbeddingService } from "../../src/infrastructure/llm/DisabledEmbeddingService";
import { createEmbeddingService } from "../../src/infrastructure/llm/createEmbeddingService";
import { JeevesEmbeddingAdapter } from "../../src/infrastructure/llm/JeevesEmbeddingAdapter";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };

function llmConfig(embed: JeevesLLMConfig["embed"]): JeevesLLMConfig {
  const slot = { model: "m", fallback: "m" };
  return {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-test",
    embed,
    timeoutMs: 1000,
    complexityThreshold: 0.7,
    extractConfidenceMin: 0.6,
    entityDedupThreshold: 0.92,
    contradictionThreshold: 0.78,
    embedDims: 2560,
    slots: { classify: slot, extract: slot, embed: slot, summarise: slot, queryAnalyse: slot, respond: slot, complexSynthesis: slot },
  };
}

describe("resolveEmbeddingSettings", () => {
  it("auto: same provider as chat when it is not Anthropic", () => {
    const r = resolveEmbeddingSettings({ llmBaseUrl: "http://ollama:11434/v1", llmApiKey: "", mode: "auto" });
    expect(r).toEqual({ baseUrl: "http://ollama:11434/v1", apiKey: "", enabled: true });
  });

  it("auto: disabled when the effective embedding host is api.anthropic.com", () => {
    const r = resolveEmbeddingSettings({ llmBaseUrl: "https://api.anthropic.com/v1", llmApiKey: "sk-ant", mode: "auto" });
    expect(r.enabled).toBe(false);
    expect(r.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("auto: a separate embedding URL re-enables embeddings for a Claude chat provider", () => {
    const r = resolveEmbeddingSettings({
      llmBaseUrl: "https://api.anthropic.com/v1/", llmApiKey: "sk-ant",
      embedBaseUrl: "http://ollama:11434/v1/", mode: "auto",
    });
    expect(r).toEqual({ baseUrl: "http://ollama:11434/v1", apiKey: "sk-ant", enabled: true });
  });

  it("uses the embedding-specific key when given, even if empty", () => {
    const r = resolveEmbeddingSettings({
      llmBaseUrl: "https://api.anthropic.com/v1", llmApiKey: "sk-ant",
      embedBaseUrl: "http://ollama:11434/v1", embedApiKey: "", mode: "auto",
    });
    expect(r.apiKey).toBe("");
  });

  it("off/on override auto-detection", () => {
    expect(resolveEmbeddingSettings({ llmBaseUrl: "http://ollama:11434/v1", llmApiKey: "", mode: "off" }).enabled).toBe(false);
    expect(resolveEmbeddingSettings({ llmBaseUrl: "https://api.anthropic.com/v1", llmApiKey: "k", mode: "on" }).enabled).toBe(true);
  });

  it("treats an unparseable URL as a non-Anthropic host", () => {
    expect(resolveEmbeddingSettings({ llmBaseUrl: "not a url", llmApiKey: "", mode: "auto" }).enabled).toBe(true);
  });
});

describe("DisabledEmbeddingService", () => {
  it("returns null vectors so consumers skip their vector steps", async () => {
    const svc = new DisabledEmbeddingService();
    await expect(svc.embed("anything")).resolves.toBeNull();
    await expect(svc.embedBatch(["a", "b"])).resolves.toEqual([null, null]);
    await expect(svc.embedBatch([])).resolves.toEqual([]);
  });
});

describe("createEmbeddingService", () => {
  it("returns the disabled service and warns once when embeddings are off", () => {
    logger.warn.mockClear();
    const svc = createEmbeddingService(llmConfig({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", enabled: false }), logger);
    expect(svc).toBeInstanceOf(DisabledEmbeddingService);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("returns the real adapter when enabled", () => {
    const svc = createEmbeddingService(llmConfig({ baseUrl: "http://ollama:11434/v1", apiKey: "", enabled: true }), logger);
    expect(svc).toBeInstanceOf(JeevesEmbeddingAdapter);
  });

  it("the real adapter calls the embedding endpoint, not the chat endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(2560).fill(0.1) }] }), { status: 200 }),
    );
    try {
      const svc = createEmbeddingService(llmConfig({ baseUrl: "http://ollama:11434/v1", apiKey: "embed-key", enabled: true }), logger);
      await expect(svc.embed("hello")).resolves.toEqual(Array(2560).fill(0.1));
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("http://ollama:11434/v1/embeddings");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer embed-key");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

it("rejects mismatched embedding dimensions rather than storing them", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({data:[{embedding:[1,2]}]})));
  try {
    const service = createEmbeddingService(llmConfig({baseUrl:"http://model.test",apiKey:"",enabled:true}),logger);
    expect(await service.embed("test")).toBeNull();
  } finally { fetchMock.mockRestore(); }
});
