import "dotenv/config";
import { createBot, initBot } from "./bot.js";
import { startHeartbeat } from "./heartbeat.js";
import { closeBrowser } from "./tools/browser.js";
import { validateConfig } from "./config.js";
import { createLogger, rotateLogs } from "./logger.js";
import { startWebhookServer, stopWebhookServer } from "./webhook.js";
import { startPrograms, stopPrograms } from "./programs.js";
import { sweepSubAgents } from "./subagent.js";
import { logEvent } from "./dashboard.js";
import { registerDashboardHooks } from "./dashboard-hooks.js";
import { startGateway, stopGateway } from "./gateway/index.js";

const log = createLogger("main");

async function main(): Promise<void> {
  await rotateLogs();

  registerDashboardHooks();

  const config = validateConfig();
  log.info(`Jarvis starting — capabilities: ${config.capabilities.join(", ")}`);

  // Start the WebSocket gateway
  startGateway();

  // Restore sessions and init bot
  await initBot();

  const bot = createBot();

  startHeartbeat(bot);
  startWebhookServer(bot);
  await startPrograms(bot);

  const sweepInterval = setInterval(() => {
    const removed = sweepSubAgents();
    if (removed > 0) log.debug(`Swept ${removed} old sub-agent runs`);
  }, 10 * 60 * 1000);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down`);
    clearInterval(sweepInterval);
    stopPrograms();
    stopGateway();
    await stopWebhookServer();
    await closeBrowser();
    await bot.stop();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("Jarvis is online");
  logEvent({ type: "message", summary: "Jarvis is online", status: "ok" });
  await bot.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
