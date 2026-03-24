/**
 * Trade outcome store — persists results to trades.jsonl for model calibration.
 *
 * Each line is a JSON record of a trade and its eventual outcome.
 * The forecaster loads recent outcomes to calibrate confidence.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("outcomes");
const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "../..");
const OUTCOMES_PATH = join(PROJECT_ROOT, "data", "trades.jsonl");

export interface TradeOutcome {
  id: string;               // unique trade ID (orderId or timestamp)
  conditionId: string;
  market: string;           // question text
  side: "YES" | "NO";
  modelProb: number;        // calibrated probability we assigned
  marketProb: number;       // what the market said at trade time
  edge: number;             // edge we calculated
  size: number;             // $ amount
  price: number;            // entry price
  placedAt: string;         // ISO timestamp
  resolvedAt?: string;      // when we checked outcome
  result?: "WIN" | "LOSS" | "VOID"; // outcome
  payout?: number;          // $ received on resolution
}

export interface CalibrationStats {
  totalTrades: number;
  resolvedTrades: number;
  winRate: number;          // wins / resolved
  avgEdgeClaimed: number;   // avg edge we thought we had
  avgModelProb: number;     // avg model probability
  avgMarketProb: number;    // avg market probability
  brierScore: number;       // lower is better, 0.25 = random
  recentCalls: RecentCall[];
}

export interface RecentCall {
  market: string;
  side: "YES" | "NO";
  modelProb: number;
  marketProb: number;
  result?: "WIN" | "LOSS" | "VOID";
  placedAt: string;
}

async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(join(PROJECT_ROOT, "data"), { recursive: true });
  } catch {
    // already exists
  }
}

export async function saveOutcome(outcome: TradeOutcome): Promise<void> {
  try {
    await ensureDataDir();
    await appendFile(OUTCOMES_PATH, JSON.stringify(outcome) + "\n", "utf-8");
    log.info(`Outcome saved: ${outcome.market.slice(0, 40)} | ${outcome.side} | ${outcome.result ?? "PENDING"}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to save outcome: ${msg}`);
  }
}

export async function loadOutcomes(): Promise<TradeOutcome[]> {
  try {
    const content = await readFile(OUTCOMES_PATH, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeOutcome);
  } catch {
    return []; // file doesn't exist yet
  }
}

export async function updateOutcome(id: string, update: Partial<TradeOutcome>): Promise<boolean> {
  try {
    const outcomes = await loadOutcomes();
    const idx = outcomes.findIndex((o) => o.id === id);
    if (idx === -1) return false;

    outcomes[idx] = { ...outcomes[idx]!, ...update } as TradeOutcome;

    await ensureDataDir();
    await writeFile(
      OUTCOMES_PATH,
      outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8",
    );
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to update outcome: ${msg}`);
    return false;
  }
}

export async function getCalibrationStats(limit = 50): Promise<CalibrationStats> {
  const outcomes = await loadOutcomes();
  const recent = outcomes.slice(-limit);

  const resolved = recent.filter((o) => o.result && o.result !== "VOID");
  const wins = resolved.filter((o) => o.result === "WIN");

  const winRate = resolved.length > 0 ? wins.length / resolved.length : 0;
  const avgEdgeClaimed = recent.length > 0
    ? recent.reduce((s, o) => s + o.edge, 0) / recent.length
    : 0;
  const avgModelProb = recent.length > 0
    ? recent.reduce((s, o) => s + o.modelProb, 0) / recent.length
    : 0;
  const avgMarketProb = recent.length > 0
    ? recent.reduce((s, o) => s + o.marketProb, 0) / recent.length
    : 0;

  // Brier score: mean squared error between model prob and actual outcome
  // Only calculable for resolved trades
  const brierScore = resolved.length > 0
    ? resolved.reduce((s, o) => {
        const actual = o.result === "WIN" ? 1 : 0;
        return s + Math.pow(o.modelProb - actual, 2);
      }, 0) / resolved.length
    : 0.25; // default: random

  const recentCalls: RecentCall[] = recent.slice(-10).map((o) => ({
    market: o.market.slice(0, 60),
    side: o.side,
    modelProb: o.modelProb,
    marketProb: o.marketProb,
    result: o.result,
    placedAt: o.placedAt,
  }));

  return {
    totalTrades: recent.length,
    resolvedTrades: resolved.length,
    winRate,
    avgEdgeClaimed,
    avgModelProb,
    avgMarketProb,
    brierScore,
    recentCalls,
  };
}
