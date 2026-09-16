import type { SchedulerPort, ScheduledJob } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";

/**
 * In-process scheduler using setTimeout. Jobs run in the same process; no persistence.
 */
export class InProcessScheduler implements SchedulerPort {
  private timeouts = new Map<string, NodeJS.Timeout>();
  private handler: ((job: ScheduledJob) => void) | null = null;

  constructor(private readonly logger: Logger) {}

  setHandler(handler: (job: ScheduledJob) => void): void {
    this.handler = handler;
  }

  schedule(job: ScheduledJob): void {
    this.cancel(job.id);
    const delay = Math.max(0, job.runAt.getTime() - Date.now());
    this.logger.debug("Job scheduled", { jobId: job.id, type: job.type, runAt: job.runAt.toISOString(), delayMs: delay });
    const timeout = setTimeout(() => {
      if (job.runAt.getTime() > Date.now()) {
        this.schedule(job);
        return;
      }
      this.timeouts.delete(job.id);
      this.logger.debug("Job fired", { jobId: job.id, type: job.type });
      this.handler?.(job);
    }, Math.min(delay, 2_147_483_647));
    this.timeouts.set(job.id, timeout);
  }

  shutdown(): void {
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
  }

  cancel(jobId: string): void {
    const t = this.timeouts.get(jobId);
    if (t) {
      clearTimeout(t);
      this.timeouts.delete(jobId);
      this.logger.debug("Job cancelled", { jobId });
    }
  }
}
