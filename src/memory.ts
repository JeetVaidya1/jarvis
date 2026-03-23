import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const AGENT_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "agent");
const MEMORY_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "memory");
const MEMORY_FILE = join(AGENT_DIR, "MEMORY.md");
const SOUL_FILE = join(AGENT_DIR, "SOUL.md");
const HEARTBEAT_FILE = join(AGENT_DIR, "HEARTBEAT.md");

function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dailyLogPath(): string {
  return join(MEMORY_DIR, `${todayDateString()}.md`);
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function loadSOUL(): Promise<string> {
  return readFileSafe(SOUL_FILE);
}

export async function loadMemory(): Promise<string> {
  return readFileSafe(MEMORY_FILE);
}

export async function loadHEARTBEAT(): Promise<string> {
  return readFileSafe(HEARTBEAT_FILE);
}

export async function loadDailyLog(): Promise<string> {
  return readFileSafe(dailyLogPath());
}

export async function updateMemory(
  content: string,
  append = false,
): Promise<void> {
  await mkdir(dirname(MEMORY_FILE), { recursive: true });
  if (append) {
    await appendFile(MEMORY_FILE, content, "utf-8");
  } else {
    await writeFile(MEMORY_FILE, content, "utf-8");
  }
}

export async function appendDailyLog(content: string): Promise<void> {
  const logPath = dailyLogPath();
  await mkdir(dirname(logPath), { recursive: true });

  const existing = await readFileSafe(logPath);
  if (existing === "") {
    const header = `# Jarvis Daily Log — ${todayDateString()}\n\n`;
    await writeFile(logPath, header + content + "\n", "utf-8");
  } else {
    await appendFile(logPath, content + "\n", "utf-8");
  }
}
