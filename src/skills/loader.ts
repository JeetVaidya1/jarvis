/**
 * Dynamic skill loader — loads tool definitions + handlers from ~/.jarvis/skills/
 * at runtime without requiring a restart.
 *
 * Each skill is a directory with an index.js file that exports:
 *   - tools: Array<{ name, description, input_schema }>
 *   - execute(toolName, input): Promise<{ text: string }>
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createLogger } from "../logger.js";
import type Anthropic from "@anthropic-ai/sdk";

const log = createLogger("skills");

const SKILLS_DIR = join(homedir(), ".jarvis", "skills");

// ── Types ──

interface SkillModule {
  tools: ReadonlyArray<Anthropic.Tool>;
  execute: (toolName: string, input: Record<string, unknown>) => Promise<{ text: string }>;
}

interface LoadedSkill {
  readonly name: string;
  readonly dir: string;
  readonly module: SkillModule;
  readonly toolNames: readonly string[];
}

// ── State ──

const loadedSkills = new Map<string, LoadedSkill>();
const toolToSkill = new Map<string, string>();

// ── Public API ──

/**
 * Load all skills from ~/.jarvis/skills/. Each subdirectory with an index.js
 * is loaded as a skill. Call this at startup and after installing new skills.
 */
export async function loadSkills(): Promise<number> {
  // Ensure skills directory exists
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
    log.info(`Created skills directory: ${SKILLS_DIR}`);
    return 0;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(SKILLS_DIR, entry.name);
    const indexPath = join(skillDir, "index.js");

    if (!existsSync(indexPath)) continue;

    try {
      // Use dynamic import with file URL and cache-busting for hot reload
      const fileUrl = pathToFileURL(indexPath).href + `?t=${Date.now()}`;
      const mod = await import(fileUrl) as SkillModule;

      if (!Array.isArray(mod.tools) || typeof mod.execute !== "function") {
        log.warn(`Skill "${entry.name}" has invalid exports — skipping`);
        continue;
      }

      const toolNames = mod.tools.map((t: Anthropic.Tool) => t.name);

      // Register
      loadedSkills.set(entry.name, {
        name: entry.name,
        dir: skillDir,
        module: mod,
        toolNames,
      });

      for (const name of toolNames) {
        toolToSkill.set(name, entry.name);
      }

      count++;
      log.info(`Loaded skill "${entry.name}" with ${toolNames.length} tool(s): ${toolNames.join(", ")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to load skill "${entry.name}": ${msg}`);
    }
  }

  log.info(`${count} skill(s) loaded from ${SKILLS_DIR}`);
  return count;
}

/**
 * Get all tool definitions from loaded skills.
 */
export function getSkillTools(): readonly Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const skill of loadedSkills.values()) {
    tools.push(...skill.module.tools);
  }
  return tools;
}

/**
 * Check if a tool name belongs to a loaded skill.
 */
export function isSkillTool(toolName: string): boolean {
  return toolToSkill.has(toolName);
}

/**
 * Execute a skill tool by name.
 */
export async function executeSkillTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ text: string }> {
  const skillName = toolToSkill.get(toolName);
  if (!skillName) {
    return { text: `ERROR: No skill found for tool "${toolName}"` };
  }

  const skill = loadedSkills.get(skillName);
  if (!skill) {
    return { text: `ERROR: Skill "${skillName}" not loaded` };
  }

  return skill.module.execute(toolName, input);
}

/**
 * List all loaded skills and their tools.
 */
export function listLoadedSkills(): string {
  if (loadedSkills.size === 0) {
    return `No skills loaded.\n\nInstall skills to: ${SKILLS_DIR}\nEach skill needs a directory with an index.js file.`;
  }

  const lines: string[] = [`**Loaded Skills** (${loadedSkills.size})`, ""];
  for (const skill of loadedSkills.values()) {
    lines.push(`**${skill.name}** (${skill.dir})`);
    for (const name of skill.toolNames) {
      lines.push(`  • ${name}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Install a skill from inline code. Creates a directory and index.js file.
 */
export async function installSkill(name: string, code: string): Promise<string> {
  const skillDir = join(SKILLS_DIR, name);
  if (existsSync(skillDir)) {
    return `ERROR: Skill "${name}" already exists at ${skillDir}`;
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "index.js"), code);

  // Reload to pick up the new skill
  await loadSkills();

  const skill = loadedSkills.get(name);
  if (!skill) {
    return `ERROR: Skill "${name}" installed but failed to load. Check the code.`;
  }

  return `Skill "${name}" installed with ${skill.toolNames.length} tool(s): ${skill.toolNames.join(", ")}`;
}
