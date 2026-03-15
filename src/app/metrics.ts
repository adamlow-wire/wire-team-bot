/**
 * Basic metrics hooks. Currently a no-op stub; replace with a real
 * implementation (e.g. prom-client, DataDog StatsD) when needed.
 *
 * Usage:
 *   import { metrics } from "./metrics";
 *   metrics.increment("tasks.created");
 *   metrics.timing("wire.send_latency_ms", elapsedMs);
 */
export interface Metrics {
  /** Increment a counter by 1 (or by `value`). */
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  /** Record a timing in milliseconds. */
  timing(name: string, ms: number, tags?: Record<string, string>): void;
  /** Record an arbitrary gauge value. */
  gauge(name: string, value: number, tags?: Record<string, string>): void;
}

const noopMetrics: Metrics = {
  increment: () => {},
  timing: () => {},
  gauge: () => {},
};

export const metrics: Metrics = noopMetrics;
