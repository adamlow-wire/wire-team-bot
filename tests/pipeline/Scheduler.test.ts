import { it, expect, vi, afterEach } from "vitest";
import { InProcessScheduler } from "../../src/infrastructure/scheduler/InProcessScheduler";
afterEach(()=>vi.useRealTimers());
it("does not overflow Node's timer limit for a distant reminder", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  const scheduler=new InProcessScheduler({debug:vi.fn()} as never);
  const handler=vi.fn();
  scheduler.setHandler(handler);
  const delay=30*24*60*60*1000;
  scheduler.schedule({id:"rem-1",type:"reminder",runAt:new Date(Date.now()+delay),payload:{reminderId:"REM-1"}});
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(handler).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(delay-2_147_483_647);
  expect(handler).toHaveBeenCalledOnce();
  scheduler.shutdown();
});
