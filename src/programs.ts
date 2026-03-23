/**
 * Standing Orders / Programs — autonomous scheduled tasks.
 * Adapted from OpenClaw's CronService pattern.
 *
 * Programs are markdown files in agent/programs/ with frontmatter:
 *
 *   ---
 *   name: Weekly Trading Summary
 *   schedule: "0 18 * * 5"    # cron expression (Fridays 6pm)
 *   enabled: true
 *   model: claude-sonnet-4-6
 *   deliver: true              # send result to Telegram
 *   ---
 *
 *   Compile a weekly trading summary from Polymarket positions...
 *
 * The body is the prompt sent to the agent.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import cron from "node-cron";
import type { Bot } from "grammy";
import { runAgent } from "./agent.js";
import { createLogger } from "./logger.js";
import { appendDailyLog } from "./memory.js";
import { emit } from "./events.js";

const log = createLogger("programs");

const PROGRAMS_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "agent",
  "programs",
);

const PROGRAM_TIMEOUT = 120_000; // 2 minutes max per program

interface ProgramConfig {
  name: string;
  schedule: string;
  enabled: boolean;
  model?: string;
  deliver: boolean;
}

interface Program {
  config: ProgramConfig;
  prompt: string;
  filename: string;
}

interface RunningProgram {
  program: Program;
  task: ReturnType<typeof cron.schedule>;
}

const runningPrograms: RunningProgram[] = [];
let botRef: Bot | null = null;
let chatIdRef: number | null = null;

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, unknown> = {};
  const lines = (match[1] ?? "").split("\n");

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Strip quotes
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    // Parse booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;

    meta[key] = value;
  }

  return { meta, body: (match[2] ?? "").trim() };
}

async function loadPrograms(): Promise<Program[]> {
  try {
    const files = await readdir(PROGRAMS_DIR);
    const programs: Program[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      try {
        const content = await readFile(join(PROGRAMS_DIR, file), "utf-8");
        const { meta, body } = parseFrontmatter(content);

        if (!body) {
          log.warn(`Program ${file} has no prompt body — skipping`);
          continue;
        }

        const schedule = meta["schedule"] as string | undefined;
        if (!schedule || !cron.validate(schedule)) {
          log.warn(`Program ${file} has invalid or missing schedule — skipping`);
          continue;
        }

        programs.push({
          config: {
            name: (meta["name"] as string) ?? file.replace(".md", ""),
            schedule,
            enabled: meta["enabled"] !== false,
            model: meta["model"] as string | undefined,
            deliver: meta["deliver"] !== false,
          },
          prompt: body,
          filename: file,
        });
      } catch (err) {
        log.error(`Failed to load program ${file}: ${err}`);
      }
    }

    return programs;
  } catch {
    // Directory doesn't exist yet — that's fine
    return [];
  }
}

async function executeProgram(program: Program): Promise<void> {
  const { config } = program;

  log.info(`Running program: ${config.name}`);
  await emit("program", "run", { name: config.name });

  try {
    const agentPromise = runAgent(program.prompt, []);
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Program timed out after ${PROGRAM_TIMEOUT}ms`)),
        PROGRAM_TIMEOUT,
      ),
    );

    const response = await Promise.race([agentPromise, timeoutPromise]);

    log.info(`Program "${config.name}" completed: ${response.slice(0, 100)}`);

    await appendDailyLog(
      `[${new Date().toISOString()}] Program "${config.name}": ${response.slice(0, 300)}`,
    );

    // Deliver to Telegram if configured
    if (config.deliver && botRef && chatIdRef) {
      const message = `📋 **Program: ${config.name}**\n\n${response}`;
      await botRef.api.sendMessage(chatIdRef, message).catch((err) => {
        log.error(`Failed to deliver program result: ${err}`);
      });
    }

    await emit("program", "completed", {
      name: config.name,
      responsePreview: response.slice(0, 200),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Program "${config.name}" failed: ${msg}`);

    await appendDailyLog(
      `[${new Date().toISOString()}] Program "${config.name}" ERROR: ${msg}`,
    );

    await emit("program", "failed", { name: config.name, error: msg });
  }
}

export async function startPrograms(bot: Bot): Promise<void> {
  const allowedUserId = process.env["TELEGRAM_ALLOWED_USER_ID"];
  if (allowedUserId) {
    botRef = bot;
    chatIdRef = Number(allowedUserId);
  }

  const programs = await loadPrograms();

  if (programs.length === 0) {
    log.info("No programs found in agent/programs/");
    return;
  }

  for (const program of programs) {
    if (!program.config.enabled) {
      log.info(`Program "${program.config.name}" is disabled — skipping`);
      continue;
    }

    const task = cron.schedule(program.config.schedule, () => {
      executeProgram(program).catch((err) => {
        log.error(`Unhandled program error: ${err}`);
      });
    });

    runningPrograms.push({ program, task });
    log.info(`Program "${program.config.name}" scheduled: ${program.config.schedule}`);
  }

  log.info(`${runningPrograms.length} program(s) active`);
}

export function stopPrograms(): void {
  for (const { task } of runningPrograms) {
    task.stop();
  }
  runningPrograms.length = 0;
}

export function listPrograms(): Array<{ name: string; schedule: string; enabled: boolean; filename: string }> {
  return runningPrograms.map(({ program }) => ({
    name: program.config.name,
    schedule: program.config.schedule,
    enabled: program.config.enabled,
    filename: program.filename,
  }));
}
