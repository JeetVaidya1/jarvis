/**
 * Semantic memory — vector embeddings stored in SQLite via sqlite-vec.
 *
 * Replaces keyword search with sentence embeddings so semantically related
 * memories are found even with zero word overlap (e.g. "prediction market"
 * matches "Polymarket").
 *
 * Stack:
 *   - better-sqlite3: sync SQLite, zero setup
 *   - sqlite-vec: vector similarity extension (~1ms queries)
 *   - @huggingface/transformers: ONNX model in-process, no server
 *   - Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~20ms on M-chip)
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
// Workaround: pipeline() return type is a deeply nested union that exceeds TS complexity limit
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipeline = any;
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createLogger } from "./logger.js";

const log = createLogger("semantic-memory");

const MEMORY_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "memory");
const DB_PATH = join(MEMORY_DIR, "vectors.db");
const EMBEDDING_DIM = 384;

// Lazy-initialized singletons
let db: Database.Database | null = null;
let embedder: AnyPipeline | null = null;

async function getEmbedder(): Promise<AnyPipeline> {
  if (!embedder) {
    log.info("Loading embedding model (first run — downloads ~25MB)...");
    // Cast via unknown to avoid TS union complexity error with pipeline() return type
    embedder = (await (pipeline as unknown as (task: string, model: string, opts: object) => Promise<FeatureExtractionPipeline>)(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "fp32" },
    ));
    log.info("Embedding model ready.");
  }
  return embedder;
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    sqliteVec.load(db);
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT    NOT NULL,
      text   TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Create vec0 virtual table — drop first to allow schema changes
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vss'")
    .get() as { name: string } | undefined;
  if (!tables) {
    database.exec(`
      CREATE VIRTUAL TABLE memory_vss
        USING vec0(embedding FLOAT[${EMBEDDING_DIM}]);
    `);
  }
}

async function embed(text: string): Promise<string> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  // sqlite-vec expects JSON array format for embeddings
  const floats = output.data.slice(0, EMBEDDING_DIM) as Float32Array;
  return JSON.stringify(Array.from(floats));
}

/** Chunk text into paragraphs (by blank lines), skip empties. */
function chunkText(text: string, source: string): Array<{ source: string; text: string }> {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20)
    .map((chunk) => ({ source, text: chunk }));
}

/**
 * Re-index all memory content. Called after every memory write.
 * Clears and rebuilds the entire vector store — safe because memory
 * is small (<500 chunks) and writes are infrequent.
 */
export async function indexMemory(fullText: string, source = "MEMORY.md"): Promise<void> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true });
    const database = getDb();

    const chunks = chunkText(fullText, source);
    if (chunks.length === 0) return;

    // Pre-compute embeddings before touching the DB
    const embeddings: string[] = [];
    for (const chunk of chunks) {
      embeddings.push(await embed(chunk.text));
    }

    // Rebuild in a transaction: drop+recreate vss, clear chunks for source, insert fresh
    database.exec("DROP TABLE IF EXISTS memory_vss");
    database.exec(`CREATE VIRTUAL TABLE memory_vss USING vec0(embedding FLOAT[${EMBEDDING_DIM}])`);
    database.prepare("DELETE FROM memory_chunks WHERE source = ?").run(source);

    const insertChunk = database.prepare(
      "INSERT INTO memory_chunks (source, text) VALUES (?, ?)",
    );
    const insertVec = database.prepare(
      "INSERT INTO memory_vss (rowid, embedding) VALUES (?, ?)",
    );

    for (let i = 0; i < chunks.length; i++) {
      const result = insertChunk.run(chunks[i]!.source, chunks[i]!.text);
      // sqlite-vec vec0 requires a true SQLite INTEGER — pass as BigInt
      const rowid = BigInt(result.lastInsertRowid);
      insertVec.run(rowid, embeddings[i]!);
    }

    log.info(`Indexed ${chunks.length} chunks from ${source}`);
  } catch (err) {
    log.error(`Index failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface SemanticSearchResult {
  text: string;
  source: string;
  distance: number;
}

/**
 * Search memory semantically. Returns top-k chunks by cosine similarity.
 */
export async function semanticSearch(
  query: string,
  topK = 8,
): Promise<SemanticSearchResult[]> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true });
    const database = getDb();

    // Check if we have any vectors
    const count = (database.prepare("SELECT COUNT(*) as n FROM memory_chunks").get() as { n: number }).n;
    if (count === 0) {
      return [];
    }

    const queryVec = await embed(query);

    const rows = database
      .prepare(`
        SELECT
          c.text,
          c.source,
          v.distance
        FROM memory_vss v
        JOIN memory_chunks c ON c.id = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `)
      .all(queryVec, topK) as Array<{ text: string; source: string; distance: number }>;

    return rows;
  } catch (err) {
    log.error(`Semantic search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Check if the vector store has been indexed (non-empty).
 */
export function isIndexed(): boolean {
  try {
    const database = getDb();
    const row = database.prepare("SELECT COUNT(*) as n FROM memory_chunks").get() as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}
