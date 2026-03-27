/**
 * BullMQ-backed scheduler for deferred and recurring jobs.
 *
 * Replaces InProcessScheduler. Uses BullMQ delayed jobs for one-off
 * reminders and BullMQ repeat (cron) jobs for periodic tasks.
 *
 * Implements SchedulerPort so callers are unaware of the implementation.
 * The handler receives ScheduledJob objects identically to InProcessScheduler.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from "bullmq";
import type { SchedulerPort, ScheduledJob } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";

const QUEUE_NAME = "scheduled";

export class BullMQScheduler implements SchedulerPort {
  private readonly queue: Queue<ScheduledJob>;
  private worker: Worker<ScheduledJob> | null = null;
  private handler: ((job: ScheduledJob) => void) | null = null;

  constructor(
    connection: ConnectionOptions,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue<ScheduledJob>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });
  }

  /**
   * Register the handler that will be called when a scheduled job fires.
   * Must be called before any jobs can be dispatched to application logic.
   */
  setHandler(handler: (job: ScheduledJob) => void): void {
    this.handler = handler;

    this.worker = new Worker<ScheduledJob>(
      QUEUE_NAME,
      async (job: Job<ScheduledJob>) => {
        this.logger.debug("BullMQScheduler: job fired", { jobId: job.id, type: job.data.type });
        this.handler?.(job.data);
      },
      { connection: this.queue.opts.connection as ConnectionOptions },
    );

    this.worker.on("failed", (job, err) => {
      this.logger.warn("BullMQScheduler: job failed", {
        jobId: job?.id,
        type: job?.data.type,
        err: String(err),
      });
    });
  }

  /**
   * Schedule a one-off job to run at job.runAt.
   * Re-scheduling the same ID cancels the previous job first.
   */
  schedule(job: ScheduledJob): void {
    const delay = Math.max(0, job.runAt.getTime() - Date.now());
    this.logger.debug("BullMQScheduler: scheduling job", {
      jobId: job.id,
      type: job.type,
      runAt: job.runAt.toISOString(),
      delayMs: delay,
    });

    // Fire-and-forget; errors logged by the failed event
    void this.queue
      .getJob(job.id)
      .then(async (existing) => {
        if (existing) await existing.remove();
        return this.queue.add("scheduled", job, { jobId: job.id, delay });
      })
      .catch((err) => {
        this.logger.warn("BullMQScheduler: failed to schedule job", {
          jobId: job.id,
          err: String(err),
        });
      });
  }

  cancel(jobId: string): void {
    void this.queue
      .getJob(jobId)
      .then(async (job) => {
        if (job) {
          await job.remove();
          this.logger.debug("BullMQScheduler: cancelled job", { jobId });
        }
      })
      .catch((err) => {
        this.logger.warn("BullMQScheduler: failed to cancel job", { jobId, err: String(err) });
      });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
