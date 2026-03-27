/**
 * BullMQ-backed processing queue for the four-tier extraction pipeline.
 *
 * Replaces InMemoryProcessingQueue<T> with the same interface. Jobs are
 * persisted in Redis, giving durability across restarts and enabling future
 * multi-worker scale-out.
 *
 * Job payloads carry the full ProcessingJob<T> and are deduplicated by
 * `${channelId}:${id}` so re-enqueuing the same message while it is still
 * waiting or active is a no-op.
 *
 * Failed jobs are retried up to MAX_RETRIES times with exponential backoff,
 * then moved to BullMQ's built-in failed set (dead-letter queue).
 */

import { Queue, Worker, type Job, type ConnectionOptions } from "bullmq";
import type { Logger } from "../../application/ports/Logger";

export interface ProcessingJob<T = unknown> {
  id: string;
  channelId: string;
  payload: T;
  enqueuedAt: Date;
}

export type WorkerFn<T> = (job: ProcessingJob<T>) => Promise<void>;

const QUEUE_NAME = "extraction";
const MAX_RETRIES = 3;
const CONCURRENCY = 5;

export class BullMQProcessingQueue<T = unknown> {
  private readonly queue: Queue<ProcessingJob<T>>;
  private worker: Worker<ProcessingJob<T>> | null = null;

  constructor(
    connection: ConnectionOptions,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue<ProcessingJob<T>>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: MAX_RETRIES,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }

  /**
   * Register the worker function and start consuming jobs.
   * Must be called once before jobs can be processed.
   */
  setWorker(fn: WorkerFn<T>): void {
    if (this.worker) {
      this.logger.warn("BullMQProcessingQueue: setWorker called more than once — ignoring");
      return;
    }

    this.worker = new Worker<ProcessingJob<T>>(
      QUEUE_NAME,
      async (job: Job<ProcessingJob<T>>) => {
        await fn(job.data);
      },
      {
        connection: this.queue.opts.connection as ConnectionOptions,
        concurrency: CONCURRENCY,
      },
    );

    this.worker.on("failed", (job, err) => {
      this.logger.warn("BullMQProcessingQueue: job failed", {
        jobId: job?.id,
        channelId: job?.data.channelId,
        attempt: job?.attemptsMade,
        err: String(err),
      });
    });

    this.logger.info("BullMQProcessingQueue: worker started", { concurrency: CONCURRENCY });
  }

  /**
   * Enqueue a processing job. Deduplicated by `${channelId}:${job.id}`.
   * Returns a Promise (fire-and-forget pattern: callers may choose to void it).
   */
  async enqueue(job: ProcessingJob<T>): Promise<void> {
    const jobId = `${job.channelId}:${job.id}`;
    await this.queue.add("extract", job, { jobId });
    this.logger.debug("BullMQProcessingQueue: enqueued", {
      jobId,
      channelId: job.channelId,
    });
  }

  get depth(): Promise<number> {
    return this.queue.count();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
