import { exec } from "node:child_process";

const BLOCKED_PATTERNS = [
  // Recursive deletion
  /rm\s+-rf\s+\//,
  /rm\s+-fr\s+\//,
  /rm\s+--no-preserve-root/,
  /sudo\s+rm\b/,
  // Disk/filesystem destruction
  /mkfs\b/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  />\s*\/dev\/nvme/,
  />\s*\/dev\/disk/,
  /wipefs\b/,
  /shred\b/,
  /truncate\s+.*\//,
  // Permission nuking
  /chmod\s+-R\s+777\s+\//,
  /chmod\s+-R\s+000/,
  /chown\s+-R\s+.*\s+\//,
  // Fork bomb
  /:(){ :\|:& };:/,
  // Recursive find + delete at root
  /find\s+\/\s+.*-delete/,
  /find\s+\/\s+.*-exec\s+rm/,
  // Force push to main/master
  /git\s+push\s+.*--force.*\s+(main|master)\b/,
  /git\s+push\s+-f\s+.*\s+(main|master)\b/,
  // Git hard reset
  /git\s+reset\s+--hard/,
  // History/disk wiping
  /history\s+-c/,
  />\s*\/dev\/null\s+2>&1\s*&/,
  // Network destructive
  /iptables\s+-F/,
  /iptables\s+--flush/,
  // Curl piped to shell (common attack vector)
  /curl\s+.*\|\s*(sudo\s+)?(ba)?sh/,
  /wget\s+.*\|\s*(sudo\s+)?(ba)?sh/,
] as const;

function isCommandBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

const DEFAULT_TIMEOUT = 120_000;

export async function shellExec(
  command: string,
  workingDir?: string,
  timeout: number = DEFAULT_TIMEOUT,
  env?: Record<string, string | undefined>,
): Promise<string> {
  if (isCommandBlocked(command)) {
    return `BLOCKED: This command matches a safety blocklist and was not executed. Command: ${command}`;
  }

  const cwd = workingDir ?? process.env["HOME"] ?? "/";

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        shell: "/bin/zsh",
        ...(env ? { env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = [stdout, stderr, error.message]
            .filter(Boolean)
            .join("\n");
          resolve(`ERROR (exit ${error.code ?? "unknown"}):\n${output}`);
          return;
        }
        const output = [stdout, stderr].filter(Boolean).join("\n");
        resolve(output || "(no output)");
      },
    );
  });
}
