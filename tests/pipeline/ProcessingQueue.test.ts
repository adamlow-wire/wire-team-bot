import { describe, it, expect, vi } from "vitest";
import { InMemoryProcessingQueue } from "../../src/infrastructure/queue/InMemoryProcessingQueue";

describe("processing queue", () => {
  it("serialises channel work, purges queued messages and aborts the in-flight job", async () => {
    const queue = new InMemoryProcessingQueue();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = vi.fn(async job => {
      if (job.id === "first") {
        await pending;
        expect(job.signal.aborted).toBe(true);
      }
    });
    queue.setWorker(worker);
    for (const id of ["first", "second"]) queue.enqueue({ id, channelId: "one", payload: "private", enqueuedAt: new Date() });
    queue.enqueue({ id: "other", channelId: "two", payload: "public", enqueuedAt: new Date() });
    expect(worker.mock.calls.map(([j]) => j.id)).toEqual(["first", "other"]);
    let cancelled = false;
    const cancelling = queue.cancelChannel("one").then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    release();
    await cancelling;
    await queue.waitForIdle();
    expect(worker.mock.calls.map(([j]) => j.id)).not.toContain("second");
  });
});
