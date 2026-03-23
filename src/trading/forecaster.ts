/**
 * Forecaster — Opus 4.6 probability estimation with anti-anchoring.
 *
 * Key techniques:
 * 1. Anti-anchoring: Claude never sees the market price during analysis
 * 2. Superforecaster prompting: decompose, base rates, multiple perspectives
 * 3. Platt scaling: correct RLHF hedging toward 50%
 * 4. Multi-perspective: base-rate, evidence-based, contrarian
 */

import { createLogger } from "../logger.js";
import { shellExec } from "../tools/shell.js";
import type { ScoredMarket } from "./scanner.js";
import { join, dirname } from "node:path";

interface CryptoPrice {
  symbol: string;
  price: number;
  change24h: number;
  change1h?: number;
}

const CRYPTO_KEYWORDS = /\b(btc|bitcoin|eth|ethereum|sol|solana|crypto|xrp|bnb|doge|dogecoin)\b/i;

async function fetchLiveCryptoContext(question: string): Promise<string | null> {
  try {
    const lower = question.toLowerCase();
    const coins: string[] = [];
    if (/btc|bitcoin/.test(lower)) coins.push("bitcoin");
    if (/eth|ethereum/.test(lower)) coins.push("ethereum");
    if (/sol|solana/.test(lower)) coins.push("solana");
    if (/xrp|ripple/.test(lower)) coins.push("ripple");
    if (coins.length === 0) coins.push("bitcoin"); // default for generic crypto

    const ids = coins.join(",");
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_1hr_change=true`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!resp.ok) return null;

    const data = await resp.json() as Record<string, { usd: number; usd_24h_change?: number; usd_1h_change?: number }>;
    const lines: string[] = ["LIVE CRYPTO DATA (fetched just now):"];
    for (const [coinId, vals] of Object.entries(data)) {
      const name = coinId.charAt(0).toUpperCase() + coinId.slice(1);
      const price = vals.usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
      const ch24 = vals.usd_24h_change?.toFixed(2) ?? "N/A";
      const ch1h = vals.usd_1h_change?.toFixed(2) ?? "N/A";
      lines.push(`  ${name}: ${price} | 1h: ${ch1h}% | 24h: ${ch24}%`);
    }
    lines.push("Use this data to ground your analysis in current price action.");
    return lines.join("\n");
  } catch {
    return null; // fail silently, forecaster works without it
  }
}

const log = createLogger("forecaster");

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "../..");

// Platt scaling parameter — stretches cautious probabilities
// sqrt(3) ≈ 1.732, calibrated for Claude's RLHF hedging
const PLATT_ALPHA = 1.732;

export interface Prediction {
  probability: number;  // calibrated probability for the YES outcome
  side: "YES" | "NO";   // which side to buy
  confidence: "LOW" | "MEDIUM" | "HIGH";
  reasoning: string;
}

function plattScale(p: number): number {
  const clamped = Math.max(0.001, Math.min(0.999, p));
  const logOdds = Math.log(clamped / (1 - clamped));
  const scaled = PLATT_ALPHA * logOdds;
  const result = 1 / (1 + Math.exp(-scaled));
  return Math.max(0.01, Math.min(0.99, result));
}

function escapeForHeredoc(str: string): string {
  return str.replace(/FORECAST_EOF/g, "FORECAST_E_O_F");
}

/**
 * Forecast a market using Opus 4.6 with anti-anchoring.
 * Returns null if Claude can't make a confident prediction.
 */
export async function forecast(market: ScoredMarket): Promise<Prediction | null> {
  // Fetch live crypto context if relevant
  let liveDataBlock = "";
  if (CRYPTO_KEYWORDS.test(market.question)) {
    const ctx = await fetchLiveCryptoContext(market.question);
    if (ctx) {
      liveDataBlock = `\n\n${ctx}\n`;
      log.info(`Injected live crypto data for: ${market.question.slice(0, 50)}`);
    }
  }

  // ANTI-ANCHORING: deliberately withhold the market price
  const prompt = escapeForHeredoc(`You are an expert superforecaster. Your job is to estimate the TRUE probability of an event.

IMPORTANT RULES:
- You do NOT know what the market thinks. Form your OWN estimate.
- DO NOT hedge toward 50%. If evidence strongly supports one side, commit to it.
- Decompose the question into sub-conditions.
- Consider base rates for this type of event.
- Think about what evidence would change your mind.
- Consider the time remaining: this market ${market.endDate ? `ends ${market.endDate}` : "has no end date"}.

THE QUESTION:
"${market.question}"
${liveDataBlock}
${market.isFastMarket ? "NOTE: This is a fast-resolving market (resolves within minutes/hours). Focus on current conditions and momentum, not long-term analysis." : ""}

Analyze from THREE perspectives:
1. BASE RATE: What's the historical base rate for this type of event?
2. EVIDENCE: What current evidence shifts the probability from the base rate?
3. CONTRARIAN: What could you be wrong about?

Then synthesize into a final estimate.

RESPOND IN EXACTLY THIS FORMAT (no other text):
PROBABILITY: [number between 0.01 and 0.99]
CONFIDENCE: [LOW or MEDIUM or HIGH]
REASONING: [one paragraph, max 100 words]`);

  try {
    const command = [
      "claude", "-p",
      "--model", "opus",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--effort", "high",
      `<<'FORECAST_EOF'\n${prompt}\nFORECAST_EOF`,
    ].join(" ");

    // Strip ANTHROPIC_API_KEY so claude CLI uses Max plan OAuth instead of depleted API credits
    const forecastEnv = { ...process.env, ANTHROPIC_API_KEY: undefined };
    const result = await shellExec(command, PROJECT_ROOT, 120_000, forecastEnv);

    if (result.startsWith("ERROR")) {
      log.error(`Forecast failed: ${result.slice(0, 100)}`);
      return null;
    }

    // Parse the response
    const probMatch = result.match(/PROBABILITY:\s*([\d.]+)/i);
    const confMatch = result.match(/CONFIDENCE:\s*(LOW|MEDIUM|HIGH)/i);
    const reasonMatch = result.match(/REASONING:\s*(.+)/is);

    if (!probMatch) {
      log.warn(`Could not parse probability from forecast: ${result.slice(0, 200)}`);
      return null;
    }

    const rawProb = parseFloat(probMatch[1] ?? "0.5");
    if (isNaN(rawProb) || rawProb < 0.01 || rawProb > 0.99) {
      log.warn(`Invalid probability: ${rawProb}`);
      return null;
    }

    // Apply Platt scaling to correct hedging
    const calibratedProb = plattScale(rawProb);

    const confidence = (confMatch?.[1]?.toUpperCase() ?? "LOW") as "LOW" | "MEDIUM" | "HIGH";
    const reasoning = reasonMatch?.[1]?.trim().slice(0, 300) ?? "";

    // Determine side: buy YES if model thinks YES is underpriced, buy NO if overpriced
    // We compare against market price AFTER forecasting (anti-anchoring preserved)
    const side: "YES" | "NO" = calibratedProb > market.yesPrice ? "YES" : "NO";

    log.info(
      `Forecast: ${market.question.slice(0, 40)} | Raw: ${(rawProb * 100).toFixed(1)}% → Calibrated: ${(calibratedProb * 100).toFixed(1)}% | Confidence: ${confidence} | Side: ${side}`,
    );

    return {
      probability: calibratedProb,
      side,
      confidence,
      reasoning,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Forecast error: ${msg}`);
    return null;
  }
}
