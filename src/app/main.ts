import dotenv from "dotenv";
import { loadConfig } from "./config";
import { initLogging, getLogger } from "./logging";
import { createContainer } from "./container";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = initLogging(config.app.logLevel);
  logger.info("Wire Team Bot starting", { logLevel: config.app.logLevel });

  const container = createContainer(config, logger);
  let sdk: Awaited<ReturnType<typeof container.getWireClient>> | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutdown requested", { signal });
    await container.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason, promise) => {
    getLogger().error("Unhandled rejection", { reason, promise: String(promise) });
  });

  try {
    sdk = await container.getWireClient();
    logger.info("Wire client connected, listening for events");
    await sdk.startListening();
  } catch (error) {
    getLogger().error("Failed to start", { err: String(error) });
    process.exit(1);
  }
}

void main();
