/**
 * Media understanding — process photos, voice, documents from Telegram.
 * Adapted from OpenClaw's media-understanding pipeline.
 *
 * - Photos → download, base64, send as vision content
 * - Voice/audio → download, transcribe via Whisper if available, else describe
 * - Documents → download, read text content
 */

import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import { createLogger } from "./logger.js";
import { shellExec } from "./tools/shell.js";

const log = createLogger("media");

export interface MediaContent {
  type: "image" | "audio" | "document";
  text: string;
  base64?: string;
  mimeType?: string;
}

async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  ext: string,
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const path = join(tmpdir(), `jarvis-${randomUUID().slice(0, 8)}${ext}`);
  await writeFile(path, buffer);
  return path;
}

async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

/**
 * Process a photo message — download and convert to base64 for vision.
 */
export async function processPhoto(ctx: Context): Promise<MediaContent | null> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return null;

  // Get largest photo
  const photo = photos[photos.length - 1];
  if (!photo?.file_id) return null;

  try {
    const path = await downloadTelegramFile(ctx, photo.file_id, ".jpg");
    const buffer = await readFile(path);
    const base64 = buffer.toString("base64");
    await cleanupFile(path);

    log.info(`Photo processed: ${buffer.length} bytes`);

    return {
      type: "image",
      text: ctx.message?.caption ?? "User sent a photo",
      base64,
      mimeType: "image/jpeg",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Photo processing failed: ${msg}`);
    return null;
  }
}

/**
 * Process voice/audio — download and transcribe.
 * Uses OpenAI Whisper CLI if available, otherwise sends description.
 */
export async function processVoice(ctx: Context): Promise<MediaContent | null> {
  const voice = ctx.message?.voice ?? ctx.message?.audio;
  if (!voice?.file_id) return null;

  try {
    const ext = ctx.message?.voice ? ".ogg" : ".mp3";
    const path = await downloadTelegramFile(ctx, voice.file_id, ext);

    // Try whisper transcription
    const transcript = await transcribeAudio(path);
    await cleanupFile(path);

    if (transcript) {
      log.info(`Voice transcribed: ${transcript.length} chars`);
      return {
        type: "audio",
        text: `[Voice message transcript]: ${transcript}`,
      };
    }

    // Fallback: describe the audio
    const duration = voice.duration ?? 0;
    return {
      type: "audio",
      text: `[Voice message received, ${duration}s duration. Transcription not available — install whisper CLI for auto-transcription]`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Voice processing failed: ${msg}`);
    return null;
  }
}

/**
 * Try to transcribe audio using available tools.
 * Checks for: whisper CLI, whisper-cli, then falls back to null.
 */
async function transcribeAudio(audioPath: string): Promise<string | null> {
  // Try whisper (OpenAI's whisper CLI)
  const whisperBins = ["whisper", "whisper-cli"];

  for (const bin of whisperBins) {
    const check = await shellExec(`which ${bin}`, undefined, 5000);
    if (check.startsWith("ERROR")) continue;

    const outputBase = audioPath.replace(/\.[^.]+$/, "");
    const result = await shellExec(
      `${bin} "${audioPath}" --model base --output_format txt --output_dir "${tmpdir()}" 2>&1`,
      undefined,
      60_000,
    );

    if (!result.startsWith("ERROR")) {
      // Read the transcript file
      try {
        const txtPath = `${outputBase}.txt`;
        const transcript = await readFile(txtPath, "utf-8");
        await cleanupFile(txtPath);
        return transcript.trim();
      } catch {
        // Try to extract from stdout
        if (result.length > 10 && !result.includes("error")) {
          return result.trim();
        }
      }
    }
  }

  return null;
}

/**
 * Process a document — download and extract text content.
 */
export async function processDocument(ctx: Context): Promise<MediaContent | null> {
  const doc = ctx.message?.document;
  if (!doc?.file_id) return null;

  const fileName = doc.file_name ?? "unknown";
  const mimeType = doc.mime_type ?? "";

  // Only handle text-based documents
  const textMimes = [
    "text/plain",
    "text/csv",
    "text/markdown",
    "application/json",
    "application/xml",
    "text/xml",
    "text/html",
    "application/x-yaml",
  ];

  const textExts = [".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".log", ".py", ".ts", ".js", ".sh"];
  const isText = textMimes.some((m) => mimeType.startsWith(m)) ||
    textExts.some((e) => fileName.toLowerCase().endsWith(e));

  try {
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const path = await downloadTelegramFile(ctx, doc.file_id, ext);

    if (isText) {
      const content = await readFile(path, "utf-8");
      await cleanupFile(path);

      const truncated = content.length > 10_000
        ? content.slice(0, 10_000) + `\n...(truncated, ${content.length} chars total)`
        : content;

      log.info(`Document processed: ${fileName} (${content.length} chars)`);

      return {
        type: "document",
        text: `[Document: ${fileName}]\n\`\`\`\n${truncated}\n\`\`\``,
      };
    }

    // PDF — try to extract text
    if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
      // Try pdftotext if available
      const check = await shellExec("which pdftotext", undefined, 5000);
      if (!check.startsWith("ERROR")) {
        const result = await shellExec(
          `pdftotext "${path}" - 2>/dev/null`,
          undefined,
          30_000,
        );
        await cleanupFile(path);

        if (!result.startsWith("ERROR") && result.length > 10) {
          const truncated = result.length > 10_000
            ? result.slice(0, 10_000) + `\n...(truncated)`
            : result;

          return {
            type: "document",
            text: `[PDF: ${fileName}]\n${truncated}`,
          };
        }
      }
      await cleanupFile(path);
    } else {
      await cleanupFile(path);
    }

    return {
      type: "document",
      text: `[Document received: ${fileName} (${mimeType || "unknown type"}). Cannot extract text from this format.]`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Document processing failed: ${msg}`);
    return null;
  }
}
