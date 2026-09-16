/**
 * Concurrency-limited in-process job queue for the four-tier processing pipeline.
 *
 * Replaces BullMQ/Redis at MVP. Rationale: message content only ever lives in
 * Node.js heap during processing (strictly better for extract-and-forget than
 * Redis TTL). Processing is intentionally transient — jobs lost on restart
 * are acceptable and desired.
 *
 * Behaviour:
 *   - Up to MAX_CONCURRENCY jobs run simultaneously.
 *   - Queue depth capped at MAX_DEPTH. When full, the oldest unprocessed job
 *     is dropped (with a warning log) before enqueueing the new one.
 *   - Worker function is set once via setWorker(); calls before it is set
 *     are queued and processed when it arrives.
 */

export interface ProcessingJob<T = unknown> {
  id: string;
  channelId: string;
  payload: T;
  enqueuedAt: Date;
  signal?: AbortSignal;
}

export type WorkerFn<T> = (job: ProcessingJob<T>) => Promise<void>;

const MAX_CONCURRENCY = 5;
const MAX_DEPTH = 500;

export class InMemoryProcessingQueue<T = unknown> {
  private readonly queue: ProcessingJob<T>[] = [];
  private worker: WorkerFn<T> | null = null;
  private running = 0;
  private readonly active = new Map<string, AbortController>();
  private readonly channelWaiters = new Map<string, Array<() => void>>();
  private readonly warn: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(warn: (msg: string, meta?: Record<string, unknown>) => void = () => {}) {
    this.warn = warn;
  }

  setWorker(fn: WorkerFn<T>): void {
    this.worker = fn;
    this.drain();
  }

  enqueue(job: ProcessingJob<T>): void {
    if (this.queue.length >= MAX_DEPTH) {
      const dropped = this.queue.shift()!;
      this.warn("InMemoryProcessingQueue overflow — dropped oldest job", {
        droppedJobId: dropped.id,
        droppedChannelId: dropped.channelId,
        queueDepth: this.queue.length,
      });
    }
    this.queue.push(job);
    this.drain();
  }

  get depth(): number {
    return this.queue.length;
  }

  get concurrency(): number {
    return this.running;
  }

  /**
   * Resolves when both the queue and all in-flight workers are idle.
   * Rejects after `timeoutMs` (default 30 s) to prevent indefinite hangs.
   */
  waitForIdle(timeoutMs = 30_000): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let stopped = false;
      const deadline = setTimeout(
        () => { stopped = true; reject(new Error("InMemoryProcessingQueue.waitForIdle timed out")); },
        timeoutMs,
      );
      const poll = () => {
        if (stopped) return;
        if (this.running === 0 && this.queue.length === 0) {
          clearTimeout(deadline);
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };
      setTimeout(poll, 100);
    });
  }

  private drain(): void {
    if (!this.worker) return;
    while (this.running < MAX_CONCURRENCY) {
      // Preserve source order within a channel; independent channels still run concurrently.
      const index = this.queue.findIndex(job => !this.active.has(job.channelId));
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      const controller = new AbortController();
      this.active.set(job.channelId, controller);
      this.running++;
      void this.worker({ ...job, signal: controller.signal })
        .catch(() => { /* Worker owns error reporting. */ })
        .finally(() => {
          this.running--;
          this.active.delete(job.channelId);
          this.channelWaiters.get(job.channelId)?.forEach(resolve => resolve());
          this.channelWaiters.delete(job.channelId);
          this.drain();
        });
    }
  }

  /** Discard queued context and wait for the cancelled worker to release all work. */
  cancelChannel(channelId: string): Promise<void> {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].channelId === channelId) this.queue.splice(i, 1);
    }
    const active = this.active.get(channelId);
    if (!active) return Promise.resolve();
    active.abort();
    return new Promise(resolve => {
      const waiters = this.channelWaiters.get(channelId) ?? [];
      waiters.push(resolve);
      this.channelWaiters.set(channelId, waiters);
    });
  }
}
