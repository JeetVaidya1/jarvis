import "dotenv/config";
import { createBot, initBot } from "./bot.js";
import { startHeartbeat } from "./heartbeat.js";
import { closeBrowser } from "./tools/browser.js";
import { validateConfig } from "./config.js";
import { createLogger, rotateLogs } from "./logger.js";
import { startWebhookServer, stopWebhookServer } from "./webhook.js";
import { startPrograms, stopPrograms } from "./programs.js";
import { sweepSubAgents } from "./subagent.js";

const log = createLogger("main");

async function main(): Promise<void> {
  // Rotate old logs
  await rotateLogs();

  // Validate all config (required + optional)
  const config = validateConfig();
  log.info(`Jarvis starting — capabilities: ${config.capabilities.join(", ")}`);

  // Restore conversation history from disk
  await initBot();

  const bot = createBot();

  // Start all systems
  startHeartbeat(bot);
  startWebhookServer(bot);
  await startPrograms(bot);

  // Periodic sub-agent cleanup (every 10 minutes)
  const sweepInterval = setInterval(() => {
    const removed = sweepSubAgents();
    if (removed > 0) log.debug(`Swept ${removed} old sub-agent runs`);
  }, 10 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down`);
    clearInterval(sweepInterval);
    stopPrograms();
    await stopWebhookServer();
    await closeBrowser();
    await bot.stop();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("Jarvis is online");
  await bot.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
