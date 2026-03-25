/**
 * Structured logging setup. Correlates by conversation ID, user ID, entity IDs.
 * Uses pino when available; falls back to console with structured fields.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function createConsoleLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const numericLevel = { debug: 0, info: 1, warn: 2, error: 3 }[level];
  const min = numericLevel;
  const log = (l: string, msg: string, data?: Record<string, unknown>) => {
    const out = { level: l, msg, time: new Date().toISOString(), ...bindings, ...data };
    process.stderr.write(JSON.stringify(out) + "\n");
  };
  return {
    child(childBindings: Record<string, unknown>) {
      return createConsoleLogger(level, { ...bindings, ...childBindings });
    },
    debug(msg: string, data?: Record<string, unknown>) {
      if (min <= 0) log("debug", msg, data);
    },
    info(msg: string, data?: Record<string, unknown>) {
      if (min <= 1) log("info", msg, data);
    },
    warn(msg: string, data?: Record<string, unknown>) {
      if (min <= 2) log("warn", msg, data);
    },
    error(msg: string, data?: Record<string, unknown>) {
      if (min <= 3) log("error", msg, data);
    },
  };
}

let rootLogger: Logger | null = null;

export function initLogging(logLevel: string): Logger {
  const level = (logLevel in { debug: 1, info: 1, warn: 1, error: 1 }
    ? logLevel
    : "info") as LogLevel;
  rootLogger = createConsoleLogger(level);
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) return initLogging(process.env.LOG_LEVEL ?? "info");
  return rootLogger;
}
