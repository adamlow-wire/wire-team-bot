import type { WireEventsHandler } from "@wireapp/wire-apps-js-sdk";
import { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import type { Config } from "../../app/config";
import type { Logger } from "../../app/logging";

/**
 * Thin adapter so the SDK's Logger interface routes through our JSON logger.
 * The SDK prefixes each message with [Namespace] already; we just forward to
 * the appropriate level with the component tag so output is consistent JSON.
 */
function makeSdkLoggerBridge(botLogger: Logger) {
  const log = botLogger.child({ component: "sdk" });
  const meta = (m: unknown): Record<string, unknown> | undefined => {
    if (m === undefined || m === null) return undefined;
    if (m instanceof Error) return { err: m.message, stack: m.stack };
    if (typeof m === "object") return m as Record<string, unknown>;
    return { detail: String(m) };
  };
  return {
    debug: (msg: string, ...rest: unknown[]) => log.debug(msg, meta(rest[0])),
    info:  (msg: string, ...rest: unknown[]) => log.info(msg,  meta(rest[0])),
    warn:  (msg: string, ...rest: unknown[]) => log.warn(msg,  meta(rest[0])),
    error: (msg: string, ...rest: unknown[]) => log.error(msg, meta(rest[0])),
  };
}

/**
 * Creates the Wire SDK instance with app-token authentication and verifies the
 * backend-reported application identity matches WIRE_SDK_APP_ID / WIRE_SDK_APP_DOMAIN.
 *
 * The SDK stores its SQLite database and CoreCrypto keystore under ./storage
 * relative to process.cwd(); this is not configurable through the public API.
 */
export async function createWireClient(
  config: Config,
  handler: WireEventsHandler,
  logger: Logger,
): Promise<WireAppSdk> {
  const sdk = await WireAppSdk.create(
    config.wire.apiToken,
    config.wire.apiHost,
    config.wire.cryptoKey,
    handler,
    makeSdkLoggerBridge(logger),
  );

  const actual = sdk.getApplicationManager().getApplicationQualifiedId();
  if (actual.id !== config.wire.appId || actual.domain !== config.wire.appDomain) {
    await sdk.close().catch(() => undefined);
    throw new Error(
      "WIRE_SDK_APP_ID / WIRE_SDK_APP_DOMAIN do not match the application identity the backend returned for WIRE_SDK_API_TOKEN",
    );
  }

  return sdk;
}
