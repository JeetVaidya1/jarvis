/**
 * Link understanding — auto-detect URLs in messages,
 * fetch content, and append to context.
 * Adapted from OpenClaw's link-understanding module.
 */

import { createLogger } from "./logger.js";
import { webFetch } from "./tools/websearch.js";

const log = createLogger("links");

const MAX_LINKS = 3;
const MAX_CONTENT_PER_LINK = 3000;

// Match bare URLs (not inside markdown link syntax)
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

// Block private/internal IPs
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /\.local$/i,
  /\.internal$/i,
];

function isBlockedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BLOCKED_HOSTS.some((pattern) => pattern.test(parsed.hostname));
  } catch {
    return true; // Invalid URL — block it
  }
}

/**
 * Extract URLs from a message text.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];

  // Deduplicate and filter
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const url of matches) {
    // Clean trailing punctuation
    const cleaned = url.replace(/[.,;:!?)]+$/, "");

    if (seen.has(cleaned)) continue;
    if (isBlockedHost(cleaned)) continue;

    seen.add(cleaned);
    urls.push(cleaned);

    if (urls.length >= MAX_LINKS) break;
  }

  return urls;
}

/**
 * Fetch content for detected URLs and format as context.
 * Returns null if no URLs found or all fetches fail.
 */
export async function expandLinks(text: string): Promise<string | null> {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  log.info(`Expanding ${urls.length} link(s)`);

  const results: string[] = [];

  for (const url of urls) {
    try {
      const content = await webFetch(url);

      if (content.startsWith("ERROR")) {
        log.warn(`Failed to fetch ${url}: ${content.slice(0, 100)}`);
        continue;
      }

      // Truncate per-link content
      const truncated = content.length > MAX_CONTENT_PER_LINK
        ? content.slice(0, MAX_CONTENT_PER_LINK) + "\n...(truncated)"
        : content;

      results.push(truncated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Link fetch error for ${url}: ${msg}`);
    }
  }

  if (results.length === 0) return null;

  return "\n\n---\n**[Auto-fetched link content]:**\n\n" + results.join("\n\n---\n\n");
}
