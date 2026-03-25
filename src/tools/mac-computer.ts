/**
 * Mac computer use — control the desktop via macOS built-ins.
 *
 * Uses:
 *   screencapture  — screenshots (built into macOS)
 *   osascript      — System Events for mouse/keyboard
 *   open           — launch apps
 *
 * No npm dependencies. No Accessibility permissions required for screencapture.
 * Mouse/keyboard control requires Accessibility access for the terminal app.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execAsync = promisify(exec);

async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { timeout: 15_000 });
}

/**
 * Take a screenshot of the entire screen (or a specific window).
 * Returns base64-encoded PNG + dimensions.
 */
export async function macScreenshot(windowTitle?: string): Promise<{ text: string; base64?: string }> {
  const path = join(tmpdir(), `jarvis-screen-${Date.now()}.png`);

  try {
    if (windowTitle) {
      // Capture specific window by title
      await run(`screencapture -x -l "$(osascript -e 'tell app "System Events" to get id of window "${windowTitle}" of process "${windowTitle}"')" "${path}"`).catch(
        () => run(`screencapture -x "${path}"`), // fallback to full screen
      );
    } else {
      await run(`screencapture -x "${path}"`);
    }

    const data = await readFile(path);
    const base64 = data.toString("base64");
    await unlink(path).catch(() => {});

    return {
      text: `Screenshot captured (${Math.round(data.length / 1024)}KB)`,
      base64,
    };
  } catch (e) {
    await unlink(path).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return { text: `Screenshot failed: ${msg}` };
  }
}

/**
 * Move mouse to (x, y) and click.
 * Requires Accessibility permissions for the terminal/app running Jarvis.
 */
export async function macClick(x: number, y: number, button: "left" | "right" = "left"): Promise<string> {
  const btn = button === "right" ? "right click" : "click";
  const script = `
    tell application "System Events"
      set the position of the mouse to {${x}, ${y}}
      delay 0.1
      ${btn} at {${x}, ${y}}
    end tell
  `;
  try {
    await run(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    return `Clicked ${button} at (${x}, ${y})`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Click failed: ${msg}. Ensure Accessibility access is granted in System Preferences > Privacy & Security > Accessibility.`;
  }
}

/**
 * Type text at the current cursor position.
 */
export async function macType(text: string): Promise<string> {
  // Escape the text for AppleScript
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${escaped}"`;
  try {
    await run(`osascript -e '${script}'`);
    return `Typed: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Type failed: ${msg}`;
  }
}

/**
 * Press a key or keyboard shortcut.
 * Examples: "return", "escape", "tab", "space", "command+c", "command+shift+4"
 */
export async function macKeyPress(key: string): Promise<string> {
  // Parse modifiers
  const parts = key.toLowerCase().split("+");
  const modifiers: string[] = [];
  let baseKey = "";

  for (const part of parts) {
    if (part === "command" || part === "cmd") modifiers.push("command down");
    else if (part === "option" || part === "alt") modifiers.push("option down");
    else if (part === "shift") modifiers.push("shift down");
    else if (part === "control" || part === "ctrl") modifiers.push("control down");
    else baseKey = part;
  }

  // Map common key names
  const keyMap: Record<string, string> = {
    enter: "return",
    esc: "escape",
    del: "delete",
    backspace: "delete",
    up: "up arrow",
    down: "down arrow",
    left: "left arrow",
    right: "right arrow",
  };
  const appleKey = keyMap[baseKey] ?? baseKey;

  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  const script = `tell application "System Events" to key code (key code of (character id (id of character "${appleKey}")  ))${using}`;

  // Simpler fallback approach using keystroke
  const keystrokeScript = modifiers.length > 0
    ? `tell application "System Events" to keystroke "${appleKey}" using {${modifiers.join(", ")}}`
    : `tell application "System Events" to key code (ASCII number "${appleKey}")`;

  try {
    await run(`osascript -e '${keystrokeScript}'`);
    return `Key pressed: ${key}`;
  } catch {
    // Try alternate approach for special keys
    try {
      const altScript = `tell application "System Events" to key code (key code of "${appleKey}")`;
      await run(`osascript -e '${altScript}'`);
      return `Key pressed: ${key}`;
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      return `Key press failed: ${msg}`;
    }
  }
}

/**
 * Open an application by name.
 */
export async function macOpenApp(appName: string): Promise<string> {
  try {
    await run(`open -a "${appName.replace(/"/g, '\\"')}"`);
    return `Opened: ${appName}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed to open ${appName}: ${msg}`;
  }
}

/**
 * Get the currently focused window and app name.
 */
export async function macGetFocusedApp(): Promise<string> {
  const script = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp
      set winTitle to ""
      try
        set winTitle to name of front window of frontApp
      end try
      return appName & ": " & winTitle
    end tell
  `;
  try {
    const { stdout } = await run(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    return `Focused: ${stdout.trim()}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Could not get focused app: ${msg}`;
  }
}

/**
 * Run an AppleScript directly.
 */
export async function macRunScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    const out = stdout.trim();
    const err = stderr.trim();
    if (err) return `Result: ${out}\nWarning: ${err}`;
    return out || "Script ran (no output)";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `AppleScript error: ${msg}`;
  }
}
