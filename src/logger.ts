import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

const LOG_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "logs");
const MAX_LOG_AGE_DAYS = 7;

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function formatMessage(
  level: LogLevel,
  subsystem: string,
  message: string,
): string {
  return `[${formatTimestamp()}] [${LEVEL_LABELS[level]}] [${subsystem}] ${message}`;
}

async function writeToLogFile(line: string): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logPath = join(LOG_DIR, `jarvis-${date}.log`);
    await appendFile(logPath, line + "\n", "utf-8");
  } catch {
    // Don't crash if logging fails
  }
}

function log(
  level: LogLevel,
  subsystem: string,
  message: string,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const formatted = formatMessage(level, subsystem, message);

  // Console output
  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  // Fire-and-forget file write
  writeToLogFile(formatted).catch(() => {});
}

export interface Logger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  child: (childName: string) => Logger;
}

export function createLogger(subsystem: string): Logger {
  return {
    debug: (msg) => log("debug", subsystem, msg),
    info: (msg) => log("info", subsystem, msg),
    warn: (msg) => log("warn", subsystem, msg),
    error: (msg) => log("error", subsystem, msg),
    child: (childName) => createLogger(`${subsystem}.${childName}`),
  };
}

/**
 * Remove log files older than MAX_LOG_AGE_DAYS.
 * Called at startup.
 */
export async function rotateLogs(): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const files = await readdir(LOG_DIR);
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith("jarvis-") || !file.endsWith(".log")) continue;

      // Extract date from filename: jarvis-2026-03-18.log
      const dateStr = file.slice(7, 17);
      const fileDate = new Date(dateStr).getTime();

      if (!isNaN(fileDate) && fileDate < cutoff) {
        await unlink(join(LOG_DIR, file)).catch(() => {});
      }
    }
  } catch {
    // Don't crash if rotation fails
  }
}
