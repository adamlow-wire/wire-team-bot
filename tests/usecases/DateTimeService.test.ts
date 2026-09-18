import { afterEach, it, expect, vi } from "vitest";
import { SystemDateTimeService } from "../../src/infrastructure/services/SystemDateTimeService";
afterEach(()=>{ vi.useRealTimers(); vi.unstubAllEnvs(); });
it.each([
  ["2026-09-16T12:00:00Z","UTC","2026-09-30T23:59:59.000Z"],
  ["2028-02-16T12:00:00Z","UTC","2028-02-29T23:59:59.000Z"],
  ["2026-10-16T12:00:00Z","Europe/London","2026-10-31T23:59:59.000Z"],
  ["2026-09-16T12:00:00Z","America/New_York","2026-10-01T03:59:59.000Z"],
])("resolves end of month at %s in %s",(now,timezone,expected)=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(now));
  expect(new SystemDateTimeService().parse("end of month",{timezone})?.value.toISOString()).toBe(expected);
});

it.each([
  ["2026-09-18T09:00:00Z", "UTC", "this Friday", "2026-09-18T12:00:00.000Z"],
  ["2026-09-18T12:00:00Z", "UTC", "this Friday", "2026-09-18T12:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "UTC", "this Friday", "2026-09-18T12:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "UTC", "Friday", "2026-09-18T12:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "UTC", "next Friday", "2026-09-25T12:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "UTC", "Monday", "2026-09-21T12:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "UTC", "Friday at 5pm", "2026-09-18T17:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "Europe/London", "this Friday", "2026-09-18T11:00:00.000Z"],
  ["2026-09-17T23:30:00Z", "Europe/London", "this Friday", "2026-09-18T11:00:00.000Z"],
  ["2026-09-19T02:00:00Z", "America/New_York", "this Friday", "2026-09-18T16:00:00.000Z"],
  ["2026-09-18T15:00:00Z", "Europe/London", "in 2 minutes", "2026-09-18T15:02:00.000Z"],
  ["2026-09-18T15:00:00Z", "Europe/London", "tomorrow at 3pm", "2026-09-19T14:00:00.000Z"],
  ["2026-10-24T09:00:00Z", "Europe/London", "tomorrow at 3pm", "2026-10-25T15:00:00.000Z"],
  ["2026-03-28T09:00:00Z", "Europe/London", "tomorrow at 3pm", "2026-03-29T14:00:00.000Z"],
  ["2026-09-18T09:00:00Z", "Europe/London", "today at 3pm UTC", "2026-09-18T15:00:00.000Z"],
])("parses at %s in %s: %s", (now, timezone, input, expected) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  // A conversation's zone must not depend on where the process is hosted.
  vi.stubEnv("TZ", "America/Los_Angeles");
  expect(new SystemDateTimeService().parse(input, { timezone })?.value.toISOString()).toBe(expected);
});

it("rejects an invalid conversation timezone", () => {
  expect(new SystemDateTimeService().parse("Friday", { timezone: "Not/AZone" })).toBeNull();
});
