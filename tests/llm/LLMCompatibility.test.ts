import { afterEach, it, expect, vi } from "vitest";
import { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
const config = { baseUrl: "http://model.test", apiKey: "synthetic", timeoutMs: 1000, slots: { extract: { model: "test", fallback: "test" } } };
afterEach(() => vi.unstubAllGlobals());
it("retries a deprecated temperature exactly once and does not log response bodies", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temperature is deprecated for this model" } }), {status:400}))
    .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})));
  vi.stubGlobal("fetch", fetch);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const result = await new LLMClientFactory(config as never,logger as never).chatCompletion("extract",[{role:"user",content:"marker"}],{temperature:0});
  expect(result.content).toBe("OK");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty("temperature");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not retry an unrelated bad request or expose its body", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "PRIVATE_CONTEXT_MARKER" } }), {status:400}));
  vi.stubGlobal("fetch", fetch);
  await expect(new LLMClientFactory(config as never,{} as never).chatCompletion("extract",[],{temperature:0})).rejects.toThrow("LLM request failed (400)");
  expect(fetch).toHaveBeenCalledOnce();
});
