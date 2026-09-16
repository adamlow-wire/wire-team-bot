import type { WireEventsHandler } from "@wireapp/wire-apps-js-sdk";
import { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import type { Config } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { makeSdkLoggerBridge } from "./SdkLoggerBridge";

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
