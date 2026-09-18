import { afterEach, expect, it, vi } from "vitest";
import { judge } from "../e2e/judge";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("supplies the evaluation date without changing the deadline assertion", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  vi.stubEnv("JEEVES_LLM_API_KEY", "synthetic");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "PASS: Tomorrow is September 17." } }] }) });
  vi.stubGlobal("fetch", fetch);
  const assertion = "The deadline was updated to tomorrow.";
  expect((await judge("Deadline set to 17 Sept 2026.", assertion)).pass).toBe(true);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.messages[1].content).toContain("Scenario reference time (UTC): 2026-09-16T12:00:00.000Z");
  expect(body.messages[1].content).toContain(`Assertion: ${assertion}`);
});

it("uses the scenario clock and timezone even when the judge runs on another day", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "PASS: Correct calendar date." } }] }) });
  vi.stubGlobal("fetch", fetch);
  const assertion = "Due Friday 18 September, not Friday 25 September.";
  await judge("Due 18 September", assertion, { referenceTime: "2026-09-17T23:30:00.000Z", timezone: "Europe/London" });
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.messages[1].content).toContain("Scenario reference time (UTC): 2026-09-17T23:30:00.000Z");
  expect(body.messages[1].content).toContain("Conversation timezone: Europe/London");
  expect(body.messages[1].content).toContain(`Assertion: ${assertion}`);
});

it("retries an explicit unsupported-temperature rejection without changing the assertion", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: "temperature is not supported" } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "FAIL: Wrong owner." } }] }) });
  vi.stubGlobal("fetch", fetch);
  expect((await judge("Alice owns it", "Bob must own it")).pass).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  const first = JSON.parse(fetch.mock.calls[0][1].body);
  const second = JSON.parse(fetch.mock.calls[1][1].body);
  expect(first.temperature).toBe(0);
  expect(second.temperature).toBeUndefined();
  expect(second.messages).toEqual(first.messages);
});

it("does not retry unrelated client errors or expose the provider body", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400,
    json: async () => ({ error: { message: "PRIVATE_PROVIDER_BODY: bad request" } }) });
  vi.stubGlobal("fetch", fetch);
  await expect(judge("answer", "assertion")).rejects.toThrow("Judge LLM request failed: HTTP 400");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retries a conflicting multiline verdict once and preserves it", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const invalid = "PASS: Looks right.\nFAIL: Actually wrong owner.";
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: invalid } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "FAIL: Wrong owner." } }] }) });
  vi.stubGlobal("fetch", fetch);
  expect(await judge("Alice owns it", "Bob must own it")).toMatchObject({ pass: false, valid: true, invalidAttempts: [invalid] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails closed when both verdicts are malformed", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "Probably correct" } }] }) });
  vi.stubGlobal("fetch", fetch);
  expect(await judge("answer", "assertion")).toMatchObject({ pass: false, valid: false, invalidAttempts: ["Probably correct", "Probably correct"] });
  expect(fetch).toHaveBeenCalledTimes(2);
});


it("retains provider truncation metadata and bounds the verdict budget", async () => {
  vi.stubEnv("JEEVES_LLM_BASE_URL", "https://model.invalid/v1");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: "" }, finish_reason: "length" }],
  }) });
  vi.stubGlobal("fetch", fetch);
  expect(await judge("answer", "assertion")).toMatchObject({ pass: false, valid: false,
    finishReason: "length", invalidAttempts: ["", ""] });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[0][1].body).max_tokens).toBe(512);
});
