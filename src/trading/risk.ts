/**
 * Risk management — edge calculation and position sizing.
 *
 * Edge = model_probability - implied_probability - transaction_costs
 * Size = fractional Kelly criterion with confidence adjustment
 */

import { createLogger } from "../logger.js";

const log = createLogger("risk");

// Polymarket fee structure
const TAKER_FEE = 0.02;  // 2% taker fee on entry

export interface EdgeResult {
  rawEdge: number;      // |model_prob - market_prob| for the traded side
  netEdge: number;      // after fees
  side: "YES" | "NO";
  winProb: number;      // probability of winning (for the side we're trading)
  marketPrice: number;  // price we'd pay for that side
}

/**
 * Calculate edge for a trade.
 *
 * @param modelYesProb - our estimated TRUE probability of YES
 * @param marketYesPrice - current market YES price (0-1)
 * @param side - which side we'd buy
 */
export function calculateEdge(
  modelYesProb: number,
  marketYesPrice: number,
  side: "YES" | "NO",
): EdgeResult {
  if (side === "YES") {
    // We think YES is underpriced
    const rawEdge = modelYesProb - marketYesPrice;
    return {
      rawEdge,
      netEdge: rawEdge - TAKER_FEE,
      side,
      winProb: modelYesProb,         // prob of winning = model's YES prob
      marketPrice: marketYesPrice,    // price we pay = YES price
    };
  } else {
    // We think NO is underpriced (YES is overpriced)
    const modelNoProb = 1 - modelYesProb;
    const marketNoPrice = 1 - marketYesPrice;
    const rawEdge = modelNoProb - marketNoPrice;
    return {
      rawEdge,
      netEdge: rawEdge - TAKER_FEE,
      side,
      winProb: modelNoProb,          // prob of winning = model's NO prob
      marketPrice: marketNoPrice,     // price we pay = NO price
    };
  }
}

/**
 * Size a position using fractional Kelly criterion.
 *
 * Kelly formula: f* = (p*b - q) / b
 *   where p = win probability, q = 1-p, b = payout odds = (1/price) - 1
 */
export function sizePosition(
  edge: EdgeResult,
  confidence: "LOW" | "MEDIUM" | "HIGH",
  availableFunds: number,
  kellyFraction: number,
  maxTradeSize: number,
): number {
  if (edge.netEdge <= 0) return 0;

  // Price we'd pay for this side
  const price = Math.max(edge.marketPrice, 0.01);

  // Payout ratio: if we're right, we get $1 per share
  const b = (1 / price) - 1;

  // Our probability of winning
  const p = edge.winProb;
  const q = 1 - p;

  const kellyF = (p * b - q) / b;

  if (kellyF <= 0) return 0;

  // Confidence multiplier
  const confidenceMultiplier: Record<string, number> = {
    LOW: 0.5,
    MEDIUM: 0.75,
    HIGH: 1.0,
  };

  const multiplier = confidenceMultiplier[confidence] ?? 0.5;

  // Final position size in USD
  const rawSize = kellyF * kellyFraction * multiplier * availableFunds;
  const capped = Math.min(rawSize, maxTradeSize);
  const final = Math.round(capped * 100) / 100;

  if (final >= 0.5) {
    log.info(
      `Size: ${edge.side} | winProb=${(p * 100).toFixed(0)}% price=${(price * 100).toFixed(0)}% | Kelly=${(kellyF * 100).toFixed(1)}% × ${kellyFraction} × ${multiplier} × $${availableFunds.toFixed(2)} = $${final.toFixed(2)}`,
    );
  }

  return final >= 0.5 ? final : 0;
}
