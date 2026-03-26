import type { WireEventsHandler } from "wire-apps-js-sdk";
import { WireAppSdk } from "wire-apps-js-sdk";
import type { Config } from "../../app/config";
import type { Logger } from "../../app/logging";

/**
 * Thin adapter so the SDK's Logger interface routes through our JSON logger.
 * The SDK prefixes each message with [Namespace] already; we just forward to
 * the appropriate level with the component tag so output is consistent JSON.
 */
function makeSdkLoggerBridge(botLogger: Logger) {
  const log = botLogger.child({ component: "sdk" });
  return {
    debug: (msg: string, ...meta: unknown[]) =>
      log.debug(msg, meta[0] as Record<string, unknown> | undefined),
    info:  (msg: string, ...meta: unknown[]) =>
      log.info(msg,  meta[0] as Record<string, unknown> | undefined),
    warn:  (msg: string, ...meta: unknown[]) =>
      log.warn(msg,  meta[0] as Record<string, unknown> | undefined),
    error: (msg: string, ...meta: unknown[]) =>
      log.error(msg, meta[0] as Record<string, unknown> | undefined),
  };
}

/**
 * Patches the SDK's default DB path and creates the Wire SDK instance.
 * Caller (container) provides the handler, config, and bot logger.
 */
export async function createWireClient(
  config: Config,
  handler: WireEventsHandler,
  dbFilePath: string,
  logger: Logger,
): Promise<WireAppSdk> {
  try {
    const sdkModule = await import("wire-apps-js-sdk/build/db/DatabaseService.js");
    const DatabaseService = (sdkModule as { DatabaseService?: unknown }).DatabaseService;
    if (DatabaseService && typeof DatabaseService === "function") {
      const Db = DatabaseService as unknown as { DEFAULT_DATABASE_PATH: string };
      Db.DEFAULT_DATABASE_PATH = dbFilePath;
    }
  } catch {
    // If we cannot patch, storage dir is still created by container.
  }

  return WireAppSdk.create(
    config.wire.userEmail,
    config.wire.userPassword,
    config.wire.userId,
    config.wire.userDomain,
    config.wire.apiHost,
    config.wire.cryptoPassword,
    handler,
    makeSdkLoggerBridge(logger),
  );
}
