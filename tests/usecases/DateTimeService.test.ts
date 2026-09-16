import { afterEach, it, expect, vi } from "vitest";
import { SystemDateTimeService } from "../../src/infrastructure/services/SystemDateTimeService";
afterEach(()=>vi.useRealTimers());
it.each([
  ["2026-09-16T12:00:00Z","UTC","2026-09-30T23:59:59.000Z"],
  ["2028-02-16T12:00:00Z","UTC","2028-02-29T23:59:59.000Z"],
  ["2026-10-16T12:00:00Z","Europe/London","2026-10-31T23:59:59.000Z"],
  ["2026-09-16T12:00:00Z","America/New_York","2026-10-01T03:59:59.000Z"],
])("resolves end of month at %s in %s",(now,timezone,expected)=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(now));
  expect(new SystemDateTimeService().parse("end of month",{timezone})?.value.toISOString()).toBe(expected);
});
