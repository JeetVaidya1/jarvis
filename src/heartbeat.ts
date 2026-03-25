import cron from "node-cron";
import type { Bot } from "grammy";
import { runAgent } from "./agent.js";
import { loadHEARTBEAT, appendDailyLog } from "./memory.js";
import { createLogger } from "./logger.js";
import { logEvent } from "./dashboard.js";

const log = createLogger("heartbeat");

const HEARTBEAT_OK = "HEARTBEAT_OK";
const HEARTBEAT_TIMEOUT = 60_000; // 60 seconds max per heartbeat

let heartbeatRunning = false;

export function startHeartbeat(bot: Bot): void {
  const allowedUserId = process.env["TELEGRAM_ALLOWED_USER_ID"];
  if (!allowedUserId) {
    log.warn("TELEGRAM_ALLOWED_USER_ID not set — heartbeat disabled");
    return;
  }

  const chatId = Number(allowedUserId);

  // Run every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    // Overlap guard: skip if previous heartbeat still running
    if (heartbeatRunning) {
      log.warn("Previous heartbeat still running — skipping this cycle");
      return;
    }

    heartbeatRunning = true;

    try {
      const heartbeatPrompt = await loadHEARTBEAT();
      if (!heartbeatPrompt) {
        log.warn("HEARTBEAT.md not found — skipping");
        return;
      }

      // Timeout guard: race the agent against a timer
      const agentPromise = runAgent(heartbeatPrompt, []);
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Heartbeat timed out after ${HEARTBEAT_TIMEOUT}ms`)),
          HEARTBEAT_TIMEOUT,
        ),
      );

      const response = await Promise.race([agentPromise, timeoutPromise]);

      if (response.trim() === HEARTBEAT_OK) {
        log.debug("Heartbeat: OK");
        await appendDailyLog(
          `[${new Date().toISOString()}] Heartbeat: OK`,
        );
        logEvent({ type: "heartbeat", summary: "Heartbeat: OK", status: "ok" });
        return;
      }

      // Agent has something to report
      log.info(`Heartbeat alert: ${response.slice(0, 100)}`);
      await appendDailyLog(
        `[${new Date().toISOString()}] Heartbeat alert: ${response.slice(0, 200)}`,
      );
      logEvent({ type: "heartbeat", summary: `Heartbeat alert: ${response.slice(0, 100)}`, status: "ok" });

      await bot.api.sendMessage(chatId, response).catch((err) => {
        log.error(`Failed to send heartbeat message: ${err}`);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Heartbeat error: ${msg}`);
      await appendDailyLog(
        `[${new Date().toISOString()}] Heartbeat ERROR: ${msg}`,
      );
      logEvent({ type: "error", summary: `Heartbeat error: ${msg.slice(0, 100)}`, status: "error" });
    } finally {
      heartbeatRunning = false;
    }
  });

  log.info("Heartbeat scheduled: every 30 minutes");
}
