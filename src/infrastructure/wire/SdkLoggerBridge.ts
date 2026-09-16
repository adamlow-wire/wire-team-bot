import type { Logger } from "../../application/ports/Logger";

/** SDK messages and metadata can include decrypted events and HTTP bodies. */
export function makeSdkLoggerBridge(botLogger: Logger) {
  const log = botLogger.child({ component: "sdk" });
  // Keep severity visible without persisting third-party free-form content.
  return {
    debug: (_msg: string, ..._rest: unknown[]) => log.debug("Wire SDK diagnostic"),
    info: (_msg: string, ..._rest: unknown[]) => log.info("Wire SDK diagnostic"),
    warn: (_msg: string, ..._rest: unknown[]) => log.warn("Wire SDK diagnostic"),
    error: (_msg: string, ..._rest: unknown[]) => log.error("Wire SDK diagnostic"),
  };
}
