import { updateMemory, appendDailyLog } from "../memory.js";

export async function memoryUpdate(
  content: string,
  mode: "append" | "overwrite",
): Promise<string> {
  try {
    const timestamp = new Date().toISOString();

    if (mode === "overwrite") {
      await updateMemory(content);
    } else {
      const timestamped = `\n\n---\n_Updated: ${timestamp}_\n${content}`;
      await updateMemory(timestamped, true);
    }

    const logSummary = content.length > 200
      ? content.slice(0, 200) + "..."
      : content;
    await appendDailyLog(
      `[${timestamp}] Memory ${mode}: ${logSummary}`,
    );

    return `OK: Memory updated (${mode})`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR updating memory: ${msg}`;
  }
}
