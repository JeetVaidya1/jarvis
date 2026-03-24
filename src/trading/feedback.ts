/**
 * Outcome feedback loop — LLM-as-Judge review of resolved trades.
 *
 * Implements Stage 2 of the SAFLA (Self-Aware Feedback Loop Architecture):
 * 1. Load resolved outcomes from trades.jsonl
 * 2. Ask Claude to identify patterns: what worked, what didn't, calibration quality
 * 3. Append dated insights to MEMORY.md
 *
 * Call manually via `jarvis_outcome_review` MCP tool, or schedule weekly.
 */

import { createLogger } from "../logger.js";
import { shellExec } from "../tools/shell.js";
import { memoryUpdate } from "../tools/memory-tool.js";
import { loadOutcomes, getCalibrationStats } from "./outcomes.js";
import type { TradeOutcome } from "./outcomes.js";

const log = createLogger("feedback");

export interface FeedbackReport {
  reviewedAt: string;
  resolvedCount: number;
  winRate: number;
  brierScore: number;
  insights: string;
}

/**
 * Build a structured text summary of resolved trades for LLM review.
 */
function buildTradeSummary(outcomes: TradeOutcome[]): string {
  const resolved = outcomes.filter((o) => o.result === "WIN" || o.result === "LOSS");
  if (resolved.length === 0) return "No resolved trades yet.";

  const lines: string[] = [
    `Total resolved trades: ${resolved.length}`,
    `Win rate: ${(resolved.filter((o) => o.result === "WIN").length / resolved.length * 100).toFixed(1)}%`,
    "",
    "Individual trades (most recent first):",
  ];

  for (const t of resolved.slice().reverse().slice(0, 30)) {
    const modelPct = (t.modelProb * 100).toFixed(1);
    const marketPct = (t.marketProb * 100).toFixed(1);
    const edgePct = (t.edge * 100).toFixed(1);
    lines.push(
      `  [${t.result}] ${t.side} "${t.market.slice(0, 70)}" | Model: ${modelPct}% vs Market: ${marketPct}% | Edge: ${edgePct}% | Size: $${t.size.toFixed(2)} | ${t.placedAt.slice(0, 10)}`,
    );
  }

  return lines.join("\n");
}

/**
 * Run the LLM review loop:
 * - Load resolved outcomes
 * - Ask Claude for pattern analysis
 * - Append insights to MEMORY.md
 */
export async function reviewOutcomes(limit = 50): Promise<FeedbackReport> {
  log.info("Starting outcome review loop...");

  const outcomes = await loadOutcomes();
  const stats = await getCalibrationStats(limit);
  const resolved = outcomes.filter((o) => o.result === "WIN" || o.result === "LOSS");

  if (resolved.length === 0) {
    log.info("No resolved trades to review.");
    return {
      reviewedAt: new Date().toISOString(),
      resolvedCount: 0,
      winRate: 0,
      brierScore: 0.25,
      insights: "No resolved trades available for review yet.",
    };
  }

  const tradeSummary = buildTradeSummary(outcomes.slice(-limit));

  const prompt = `You are reviewing the trading performance of an autonomous Polymarket prediction market bot.

Here are the resolved trades:

${tradeSummary}

Calibration stats:
- Win rate: ${(stats.winRate * 100).toFixed(1)}%
- Avg model probability: ${(stats.avgModelProb * 100).toFixed(1)}%
- Avg market probability: ${(stats.avgMarketProb * 100).toFixed(1)}%
- Brier score: ${stats.brierScore.toFixed(3)} (0.25 = random, lower is better)

Analyze these results and provide:
1. **Calibration quality** — Is the model over/under-confident? Does model prob correlate with outcomes?
2. **Market type patterns** — Which market types (crypto price, esports, stocks) show real edge vs false edge?
3. **Edge thresholds** — Are high-edge trades actually winning more? Any pattern in the edge sizes?
4. **Failure modes** — What common mistakes are being made?
5. **Actionable recommendations** — 2-3 specific changes to improve performance.

Be concise and direct. Focus on patterns that will improve future decisions.`;

  let insights: string;
  try {
    const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/`/g, "\\`");
    const result = await shellExec(`claude --print "${escaped}"`, undefined, 60_000);
    insights = result.trim() || "Review completed but no insights generated.";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`LLM review failed: ${msg}`);
    insights = `LLM review failed: ${msg}`;
  }

  const reviewedAt = new Date().toISOString();
  const report: FeedbackReport = {
    reviewedAt,
    resolvedCount: resolved.length,
    winRate: stats.winRate,
    brierScore: stats.brierScore,
    insights,
  };

  // Append dated insights to MEMORY.md
  const memoryEntry = [
    `\n---\n_Outcome Review — ${reviewedAt.slice(0, 10)}_`,
    `Resolved: ${resolved.length} trades | Win rate: ${(stats.winRate * 100).toFixed(1)}% | Brier: ${stats.brierScore.toFixed(3)}`,
    "",
    insights,
    "---",
  ].join("\n");

  await memoryUpdate(memoryEntry, "append");
  log.info(`Outcome review complete. ${resolved.length} trades reviewed, insights appended to memory.`);

  return report;
}

/**
 * Quick stats summary without running the full LLM review.
 * Used by the trading engine to show current performance at a glance.
 */
export async function getPerformanceSummary(): Promise<string> {
  const stats = await getCalibrationStats(50);

  if (stats.resolvedTrades === 0) {
    return `No resolved trades yet. Total trades placed: ${stats.totalTrades}`;
  }

  const lines = [
    `**Trading Performance Summary**`,
    `Resolved: ${stats.resolvedTrades} | Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Brier score: ${stats.brierScore.toFixed(3)} (0.25 = random)`,
    `Avg model prob: ${(stats.avgModelProb * 100).toFixed(1)}% vs Avg market: ${(stats.avgMarketProb * 100).toFixed(1)}%`,
    "",
    "Recent calls:",
  ];

  for (const call of stats.recentCalls) {
    const resultTag = call.result ? `[${call.result}]` : "[PENDING]";
    lines.push(
      `  ${resultTag} ${call.side} "${call.market.slice(0, 50)}" | Model: ${(call.modelProb * 100).toFixed(1)}% vs Market: ${(call.marketProb * 100).toFixed(1)}%`,
    );
  }

  return lines.join("\n");
}
