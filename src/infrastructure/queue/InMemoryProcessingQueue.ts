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
}

export type WorkerFn<T> = (job: ProcessingJob<T>) => Promise<void>;

const MAX_CONCURRENCY = 5;
const MAX_DEPTH = 500;

export class InMemoryProcessingQueue<T = unknown> {
  private readonly queue: ProcessingJob<T>[] = [];
  private worker: WorkerFn<T> | null = null;
  private running = 0;
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

  private drain(): void {
    if (!this.worker) return;
    while (this.running < MAX_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      void this.worker(job)
        .catch(() => {
          // Worker errors are the worker's responsibility to handle/log.
          // We never let them crash the drain loop.
        })
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}
