/**
 * Port interface for the message processing queue.
 * Implemented by BullMQProcessingQueue (production) and InMemoryProcessingQueue (tests/CLI).
 */

export interface ProcessingJobData<T = unknown> {
  id: string;
  channelId: string;
  payload: T;
  enqueuedAt: Date;
}

export interface ProcessingQueuePort<T = unknown> {
  enqueue(job: ProcessingJobData<T>): void | Promise<void>;
}
