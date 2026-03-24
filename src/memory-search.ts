/**
 * Memory search — semantic (vector) primary, keyword fallback.
 *
 * Semantic search uses sentence embeddings (all-MiniLM-L6-v2) stored in
 * sqlite-vec. Falls back to keyword intersection if the vector store is
 * empty or unavailable.
 */

import { loadMemory, loadDailyLog } from "./memory.js";
import { semanticSearch, isIndexed } from "./semantic-memory.js";
import { createLogger } from "./logger.js";

const log = createLogger("memory-search");

/**
 * Search memory semantically. Falls back to keyword search if vector store
 * is empty (e.g. first run before any indexing).
 */
export async function searchMemory(query: string, maxResults = 10): Promise<string> {
  try {
    // Try semantic search first
    if (isIndexed()) {
      const results = await semanticSearch(query, maxResults);
      if (results.length > 0) {
        const lines = [`Semantic memory search for "${query}" (${results.length} results):\n`];
        for (const r of results) {
          const similarity = (1 - r.distance).toFixed(3);
          lines.push(`--- [${r.source}] similarity: ${similarity} ---\n${r.text}`);
        }
        log.info(`Semantic search: "${query}" → ${results.length} matches`);
        return lines.join("\n\n");
      }
    }

    // Fallback: keyword search over raw memory text
    return await keywordSearch(query, maxResults);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Memory search failed: ${msg}`);
    // Last resort: keyword search
    try {
      return await keywordSearch(query, maxResults);
    } catch {
      return `Memory search error: ${msg}`;
    }
  }
}

async function keywordSearch(query: string, maxResults: number): Promise<string> {
  const [memory, dailyLog] = await Promise.all([loadMemory(), loadDailyLog()]);
  const combined = (memory || "") + "\n\n--- TODAY'S LOG ---\n\n" + (dailyLog || "");

  const lines = combined.split("\n");
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  const matchingLines: Array<{ lineNum: number; line: string; score: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > 0) {
      matchingLines.push({ lineNum: i, line: lines[i]!, score });
    }
  }

  matchingLines.sort((a, b) => b.score - a.score);
  const top = matchingLines.slice(0, maxResults);

  if (top.length === 0) {
    return `No memory entries found matching: "${query}"`;
  }

  const resultLines: string[] = [`Keyword memory search for "${query}" (${top.length} matches):\n`];
  for (const match of top) {
    const contextStart = Math.max(0, match.lineNum - 1);
    const contextEnd = Math.min(lines.length - 1, match.lineNum + 1);
    const contextBlock = lines.slice(contextStart, contextEnd + 1).join("\n");
    resultLines.push(`--- line ${match.lineNum + 1} (score: ${match.score}) ---\n${contextBlock}`);
  }

  log.info(`Keyword search: "${query}" → ${top.length} matches`);
  return resultLines.join("\n\n");
}
