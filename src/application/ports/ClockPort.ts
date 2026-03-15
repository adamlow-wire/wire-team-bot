/**
 * Port for the system clock. Injecting this instead of calling `new Date()` / `Date.now()`
 * directly makes scheduling logic deterministic in unit tests.
 */
export interface ClockPort {
  now(): Date;
  nowMs(): number;
}
