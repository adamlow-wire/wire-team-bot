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
