/**
 * Claude Code CLI integration — routes tasks through `claude -p` which is
 * unlimited on the Max plan. Saves API costs by offloading heavy work
 * (coding, research, analysis) to the CLI instead of the Anthropic API.
 *
 * Three modes:
 *  1. claude_code — general purpose: coding, research, file analysis
 *  2. claude_code_edit — targeted file editing with context
 *  3. claude_code_review — code review with structured output
 */

import { shellExec, shellExecStream } from "./shell.js";
import { createLogger } from "../logger.js";

const log = createLogger("claude-code");

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const MAX_TIMEOUT = 600_000;    // 10 minutes

function escapeForShell(str: string): string {
  // Use heredoc-style input to avoid shell escaping issues
  return str.replace(/'/g, "'\\''");
}

interface ClaudeCodeOptions {
  workingDir?: string;
  model?: string;          // "sonnet", "opus", "haiku"
  systemPrompt?: string;
  allowedTools?: string[];
  timeout?: number;
  maxBudget?: number;      // max $ to spend (safety cap)
  outputFormat?: "text" | "json";
  effort?: "low" | "medium" | "high" | "max";
  onChunk?: (chunk: string) => void;
}

/**
 * Run a task through Claude Code CLI.
 * This is FREE on the Max plan — use it for heavy lifting.
 */
export async function claudeCode(
  prompt: string,
  options: ClaudeCodeOptions = {},
): Promise<string> {
  const {
    workingDir,
    model,
    systemPrompt,
    allowedTools,
    timeout = DEFAULT_TIMEOUT,
    maxBudget,
    outputFormat = "text",
    effort,
    onChunk,
  } = options;

  const cappedTimeout = Math.min(timeout, MAX_TIMEOUT);

  // Build the command
  const parts = ["claude", "-p", "--dangerously-skip-permissions"];

  if (model) parts.push("--model", model);
  if (outputFormat === "json") parts.push("--output-format", "json");
  if (effort) parts.push("--effort", effort);
  if (maxBudget) parts.push("--max-budget-usd", maxBudget.toString());

  if (systemPrompt) {
    parts.push("--system-prompt", `'${escapeForShell(systemPrompt)}'`);
  }

  if (allowedTools && allowedTools.length > 0) {
    parts.push("--allowedTools", `"${allowedTools.join(" ")}"`);
  }

  // Use heredoc for the prompt to handle multi-line and special chars
  const command = `${parts.join(" ")} <<'JARVIS_PROMPT_EOF'\n${prompt}\nJARVIS_PROMPT_EOF`;

  log.info(`Claude Code task: ${prompt.slice(0, 80)}... (model: ${model ?? "default"}, timeout: ${cappedTimeout}ms)`);

  if (onChunk) {
    const result = await shellExecStream(command, onChunk, workingDir, cappedTimeout, undefined);
    if (result.startsWith("ERROR")) {
      log.error(`Claude Code failed: ${result.slice(0, 200)}`);
    } else {
      log.info(`Claude Code completed: ${result.length} chars`);
    }
    return result;
  }

  const result = await shellExec(command, workingDir, cappedTimeout);

  if (result.startsWith("ERROR")) {
    log.error(`Claude Code failed: ${result.slice(0, 200)}`);
  } else {
    log.info(`Claude Code completed: ${result.length} chars`);
  }

  return result;
}

/**
 * Use Claude Code for coding tasks — edits files directly.
 * Best for: bug fixes, refactoring, adding features.
 */
export async function claudeCodeEdit(
  task: string,
  projectDir: string,
  options: Omit<ClaudeCodeOptions, "workingDir"> = {},
): Promise<string> {
  return claudeCode(task, {
    ...options,
    workingDir: projectDir,
    allowedTools: options.allowedTools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  });
}

/**
 * Use Claude Code for code review — read-only, structured analysis.
 */
export async function claudeCodeReview(
  task: string,
  projectDir: string,
  options: Omit<ClaudeCodeOptions, "workingDir"> = {},
): Promise<string> {
  const reviewPrompt = `You are reviewing code. Do NOT make any changes. Only analyze and report.\n\n${task}`;

  return claudeCode(reviewPrompt, {
    ...options,
    workingDir: projectDir,
    allowedTools: ["Read", "Glob", "Grep"],
  });
}

/**
 * Use Claude Code for research — web search, file reading, analysis.
 * Great for sub-agents doing background research.
 */
export async function claudeCodeResearch(
  task: string,
  options: Omit<ClaudeCodeOptions, "allowedTools"> = {},
): Promise<string> {
  return claudeCode(task, {
    ...options,
    allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
    effort: options.effort ?? "high",
  });
}
