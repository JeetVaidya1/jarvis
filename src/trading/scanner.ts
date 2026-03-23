/**
 * Market Scanner — discover and score tradeable markets.
 *
 * Scoring system (0-100):
 * - Volume: high volume = more reliable prices
 * - Liquidity: need enough to enter/exit
 * - Probability sweet spot: 15-85% (extremes = no edge)
 * - Time to expiry: 1h-60 days preferred
 * - Spread: tight = better entry
 * - Accepting orders: must be true
 */

import { createLogger } from "../logger.js";

const log = createLogger("scanner");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface ScoredMarket {
  conditionId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  spread: number;
  endDate: string | null;
  hoursToExpiry: number;
  score: number;
  tokenIds: [string, string]; // [yesTokenId, noTokenId]
  negRisk: boolean;
  isFastMarket: boolean;
}

interface GammaRawMarket {
  conditionId: string;
  question: string;
  outcomePrices: string;     // JSON string: '["0.55", "0.45"]'
  clobTokenIds: string;      // JSON string
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  negRisk: boolean;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  tags?: string;
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch { /* */ }
  }
  return [];
}

async function fetchGammaMarkets(path: string): Promise<GammaRawMarket[]> {
  try {
    const response = await fetch(`${GAMMA_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data as GammaRawMarket[] : [];
  } catch {
    return [];
  }
}

function scoreMarket(m: GammaRawMarket): ScoredMarket | null {
  // Must be active and accepting orders
  if (!m.active || m.closed || !m.acceptingOrders) return null;
  if (!m.conditionId || !m.question) return null;

  const prices = parseJsonStringArray(m.outcomePrices);
  const tokenIds = parseJsonStringArray(m.clobTokenIds);

  if (prices.length < 2 || tokenIds.length < 2) return null;

  const yesPrice = parseFloat(prices[0] ?? "0");
  const noPrice = parseFloat(prices[1] ?? "0");

  if (isNaN(yesPrice) || isNaN(noPrice) || yesPrice <= 0 || noPrice <= 0) return null;

  const volume = parseFloat(m.volume || "0");
  const liquidity = parseFloat(m.liquidity || "0");
  const spread = m.spread ?? Math.abs(yesPrice + noPrice - 1);

  // Calculate hours to expiry
  let hoursToExpiry = Infinity;
  if (m.endDate) {
    const end = new Date(m.endDate).getTime();
    hoursToExpiry = Math.max(0, (end - Date.now()) / (1000 * 60 * 60));
  }

  // Skip expired or about-to-expire (unless fast market)
  const isFastMarket = hoursToExpiry < 1;
  if (hoursToExpiry <= 0) return null;

  // ── Scoring ──
  let score = 0;

  // Volume score (0-20)
  if (volume > 500_000) score += 20;
  else if (volume > 100_000) score += 15;
  else if (volume > 20_000) score += 10;
  else if (volume > 5_000) score += 5;

  // Liquidity score (0-15)
  if (liquidity > 50_000) score += 15;
  else if (liquidity > 10_000) score += 10;
  else if (liquidity > 2_000) score += 5;

  // Probability sweet spot (0-15, penalty for extremes)
  if (yesPrice >= 0.15 && yesPrice <= 0.85) score += 15;
  else if (yesPrice >= 0.10 && yesPrice <= 0.90) score += 8;
  else if (yesPrice < 0.05 || yesPrice > 0.95) score -= 20; // Kill extremes

  // Time to expiry — heavily favor short-term for capital turnover
  if (hoursToExpiry < 1) {        // < 1 hour (fast market)
    score += 25;
  } else if (hoursToExpiry < 4) { // 1–4 hours
    score += 20;
  } else if (hoursToExpiry < 24) { // 4–24 hours
    score += 10;
  } else if (hoursToExpiry <= 24 * 60) { // 1–60 days
    score += 3;
  } else {
    score -= 10; // Long-dated, penalize heavily
  }

  // Spread score (0-10)
  if (spread < 0.02) score += 10;
  else if (spread < 0.05) score += 7;
  else if (spread < 0.10) score += 3;
  else score -= 5; // Wide spread = bad

  // Minimum score to be tradeable
  if (score < 15) return null;

  return {
    conditionId: m.conditionId,
    question: m.question,
    yesPrice,
    noPrice,
    volume,
    liquidity,
    spread,
    endDate: m.endDate || null,
    hoursToExpiry,
    score,
    tokenIds: [tokenIds[0] ?? "", tokenIds[1] ?? ""],
    negRisk: m.negRisk ?? false,
    isFastMarket,
  };
}

/**
 * Scan for tradeable markets. Returns scored and sorted list.
 * @param includeFastMarkets - include 5min/fast markets
 * @param maxHoursToExpiry - only return markets expiring within this many hours (default: Infinity)
 */
export async function scanMarkets(
  includeFastMarkets: boolean = true,
  maxHoursToExpiry: number = Infinity,
): Promise<ScoredMarket[]> {
  log.info("Scanning markets...");

  // Fetch from multiple sources in parallel
  const fetches = [
    // High-volume active markets
    fetchGammaMarkets("/markets?closed=false&active=true&order=volume&ascending=false&limit=50"),
    // Recently active markets
    fetchGammaMarkets("/markets?closed=false&active=true&order=liquidity&ascending=false&limit=30"),
    // Soonest-expiring markets first (key for short-term focus)
    fetchGammaMarkets("/markets?closed=false&active=true&order=endDate&ascending=true&limit=50"),
  ];

  if (includeFastMarkets) {
    // 1-min, 5-min, and crypto fast-resolving markets
    fetches.push(
      fetchGammaMarkets("/markets?closed=false&active=true&tag_id=1min&limit=20"),
      fetchGammaMarkets("/markets?closed=false&active=true&tag_id=5min&limit=30"),
      fetchGammaMarkets("/markets?closed=false&active=true&tag_id=crypto&limit=20"),
    );
  }

  const allResults = await Promise.all(fetches);
  const allMarkets = allResults.flat();

  // Deduplicate by conditionId
  const seen = new Set<string>();
  const unique: GammaRawMarket[] = [];
  for (const m of allMarkets) {
    if (m.conditionId && !seen.has(m.conditionId)) {
      seen.add(m.conditionId);
      unique.push(m);
    }
  }

  // Score and filter
  const scored: ScoredMarket[] = [];
  for (const m of unique) {
    const result = scoreMarket(m);
    if (result) scored.push(result);
  }

  // Filter by max hours to expiry if set
  const filtered = maxHoursToExpiry === Infinity
    ? scored
    : scored.filter((m) => m.hoursToExpiry <= maxHoursToExpiry);

  // Sort by score descending
  filtered.sort((a, b) => b.score - a.score);

  log.info(`Scanned ${unique.length} markets, ${filtered.length} passed filters (maxHoursToExpiry: ${maxHoursToExpiry === Infinity ? "∞" : maxHoursToExpiry + "h"})`);

  return filtered;
}
