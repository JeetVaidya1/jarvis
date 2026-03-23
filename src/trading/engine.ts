/**
 * Autonomous Polymarket Trading Engine
 *
 * Pipeline (runs every cycle):
 * 1. Scan markets (Gamma API)
 * 2. Score & filter (liquidity, volume, probability sweet spot, expiry)
 * 3. Research & forecast (Opus 4.6 with anti-anchoring)
 * 4. Calculate edge (model_prob - market_prob - fees)
 * 5. Size position (fractional Kelly)
 * 6. Execute (CLOB SDK)
 * 7. Monitor positions (stop-loss, take-profit, expiry)
 */

import { createLogger } from "../logger.js";
import { appendDailyLog } from "../memory.js";
import { memoryUpdate } from "../tools/memory-tool.js";
import { emit } from "../events.js";
import {
  scanMarkets,
  type ScoredMarket,
} from "./scanner.js";
import { forecast } from "./forecaster.js";
import { calculateEdge, sizePosition } from "./risk.js";
import { executeOrder, getBalance, getOpenPositions } from "./executor.js";

const log = createLogger("trading");

export interface TradingConfig {
  maxTradeSize: number;       // max $ per trade
  maxTotalDeployed: number;   // max $ total across all positions
  maxOpenPositions: number;   // max concurrent positions
  minEdge: number;            // minimum edge after fees to trade (0.04 = 4%)
  kellyFraction: number;      // fraction of Kelly (0.25 = quarter-Kelly)
  cycleSleepMs: number;       // time between cycles
  enableFastMarkets: boolean; // trade 5-min BTC markets
  maxHoursToExpiry: number;   // only trade markets expiring within N hours (1 = sub-1hr focus)
  dryRun: boolean;            // simulate only
}

export const DEFAULT_CONFIG: TradingConfig = {
  maxTradeSize: 8,
  maxTotalDeployed: 20,
  maxOpenPositions: 4,
  minEdge: 0.04,
  kellyFraction: 0.35,
  cycleSleepMs: 2 * 60 * 1000, // 2 minutes (faster cycles for short-term markets)
  enableFastMarkets: true,
  maxHoursToExpiry: 6,          // markets expiring within 6 hours for capital turnover (short-expiry still scored highest)
  dryRun: false,
};

export interface TradeRecord {
  timestamp: string;
  market: string;
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  price: number;
  modelProb: number;
  marketProb: number;
  edge: number;
  orderId?: string;
  status: "placed" | "failed" | "simulated";
}

let isRunning = false;
let shouldStop = false;
const tradeHistory: TradeRecord[] = [];

export function getTradeHistory(): readonly TradeRecord[] {
  return tradeHistory;
}

export function isEngineRunning(): boolean {
  return isRunning;
}

/**
 * Run one trading cycle: scan → filter → forecast → trade
 */
export async function runTradingCycle(config: TradingConfig): Promise<string> {
  const cycleStart = Date.now();
  const results: string[] = [];

  try {
    // Check balance
    const balance = await getBalance();
    if (balance < 1) {
      return "Balance too low to trade ($" + balance.toFixed(2) + ")";
    }

    // Check open positions
    const positions = await getOpenPositions();
    const totalDeployed = positions.reduce((sum, p) => sum + p.size * p.avgPrice, 0);

    if (positions.length >= config.maxOpenPositions) {
      results.push(`Max positions reached (${positions.length}/${config.maxOpenPositions})`);
    }

    if (totalDeployed >= config.maxTotalDeployed) {
      results.push(`Max deployment reached ($${totalDeployed.toFixed(2)}/$${config.maxTotalDeployed})`);
    }

    const availableFunds = Math.min(
      balance,
      config.maxTotalDeployed - totalDeployed,
    );

    if (availableFunds < 1 || positions.length >= config.maxOpenPositions) {
      // Just monitor existing positions
      results.push(`Balance: $${balance.toFixed(2)} | Deployed: $${totalDeployed.toFixed(2)} | Positions: ${positions.length}`);
      return results.join("\n");
    }

    // Scan and score markets
    log.info("Scanning markets...");
    const markets = await scanMarkets(config.enableFastMarkets, config.maxHoursToExpiry);

    if (markets.length === 0) {
      results.push("No tradeable markets found this cycle");
      return results.join("\n");
    }

    results.push(`Scanned ${markets.length} candidate markets`);

    // Skip markets we already have positions in
    const heldConditionIds = new Set(positions.map((p) => p.conditionId));

    // Evaluate top markets
    const candidates = markets
      .filter((m) => !heldConditionIds.has(m.conditionId))
      .slice(0, 5); // Evaluate top 5

    let tradePlaced = false;

    for (const market of candidates) {
      if (tradePlaced) break; // One trade per cycle to be safe

      try {
        // Forecast with anti-anchoring (Opus doesn't see the market price)
        log.info(`Forecasting: ${market.question.slice(0, 60)}...`);
        const prediction = await forecast(market);

        if (!prediction) {
          log.info(`No forecast for: ${market.question.slice(0, 40)}`);
          continue;
        }

        // Calculate edge
        const edge = calculateEdge(
          prediction.probability,
          market.yesPrice,
          prediction.side,
        );

        log.info(
          `${market.question.slice(0, 40)} | Model: ${(prediction.probability * 100).toFixed(1)}% | Market: ${(market.yesPrice * 100).toFixed(1)}% | Edge: ${(edge.netEdge * 100).toFixed(1)}% | Side: ${prediction.side}`,
        );

        if (edge.netEdge < config.minEdge) {
          continue; // Not enough edge
        }

        // Size the position
        const positionSize = sizePosition(
          edge,
          prediction.confidence,
          availableFunds,
          config.kellyFraction,
          config.maxTradeSize,
        );

        if (positionSize < 0.5) {
          continue; // Position too small
        }

        // Execute
        const tradeRecord: TradeRecord = {
          timestamp: new Date().toISOString(),
          market: market.question,
          conditionId: market.conditionId,
          side: prediction.side,
          size: positionSize,
          price: prediction.side === "YES" ? market.yesPrice : (1 - market.yesPrice),
          modelProb: prediction.probability,
          marketProb: market.yesPrice,
          edge: edge.netEdge,
          status: "simulated",
        };

        if (config.dryRun) {
          tradeRecord.status = "simulated";
          results.push(
            `[SIM] ${prediction.side} ${market.question.slice(0, 40)} | $${positionSize.toFixed(2)} @ ${(tradeRecord.price * 100).toFixed(1)}% | Edge: ${(edge.netEdge * 100).toFixed(1)}%`,
          );
        } else {
          const orderId = await executeOrder(
            market.conditionId,
            prediction.side,
            positionSize,
            market.tokenIds,
            market.negRisk,
          );

          if (orderId) {
            tradeRecord.status = "placed";
            tradeRecord.orderId = orderId;
            tradePlaced = true;
            results.push(
              `TRADE: ${prediction.side} ${market.question.slice(0, 40)} | $${positionSize.toFixed(2)} @ ${(tradeRecord.price * 100).toFixed(1)}% | Edge: ${(edge.netEdge * 100).toFixed(1)}% | Order: ${orderId}`,
            );
          } else {
            tradeRecord.status = "failed";
            results.push(`FAILED: ${market.question.slice(0, 40)}`);
          }
        }

        tradeHistory.push(tradeRecord);

        // Log to memory
        const logLine = `[TRADE ${tradeRecord.status.toUpperCase()}] ${tradeRecord.timestamp} | ${tradeRecord.side} "${tradeRecord.market}" | $${tradeRecord.size.toFixed(2)} @ ${(tradeRecord.price * 100).toFixed(1)}% | Edge: ${(tradeRecord.edge * 100).toFixed(1)}% | Model: ${(tradeRecord.modelProb * 100).toFixed(1)}%`;
        await memoryUpdate(logLine, "append");
        await emit("trading", "trade", tradeRecord as unknown as Record<string, unknown>);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Error evaluating ${market.question.slice(0, 40)}: ${msg}`);
      }
    }

    if (!tradePlaced && results.length <= 1) {
      results.push("No markets met edge threshold this cycle");
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    results.push(`Cycle completed in ${elapsed}s`);

    return results.join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Trading cycle error: ${msg}`);
    return `ERROR: ${msg}`;
  }
}

/**
 * Start the continuous trading loop.
 */
export async function startTradingLoop(
  config: TradingConfig,
  onUpdate?: (msg: string) => Promise<void>,
): Promise<void> {
  if (isRunning) {
    log.warn("Trading loop already running");
    return;
  }

  isRunning = true;
  shouldStop = false;

  log.info("Trading loop started");
  await appendDailyLog(`[${new Date().toISOString()}] Trading engine started | Config: maxTrade=$${config.maxTradeSize}, maxDeployed=$${config.maxTotalDeployed}, minEdge=${(config.minEdge * 100).toFixed(0)}%, dryRun=${config.dryRun}`);

  if (onUpdate) {
    await onUpdate(`Trading engine started. Max per trade: $${config.maxTradeSize}, min edge: ${(config.minEdge * 100).toFixed(0)}%`).catch(() => {});
  }

  while (!shouldStop) {
    try {
      const result = await runTradingCycle(config);
      log.info(`Cycle result: ${result.slice(0, 200)}`);

      // Only notify on trades or errors
      if (onUpdate && (result.includes("TRADE:") || result.includes("ERROR"))) {
        await onUpdate(result).catch(() => {});
      }

      await appendDailyLog(`[${new Date().toISOString()}] Trading cycle: ${result.slice(0, 300)}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Trading loop error: ${msg}`);
    }

    // Wait for next cycle
    if (!shouldStop) {
      await new Promise((r) => setTimeout(r, config.cycleSleepMs));
    }
  }

  isRunning = false;
  log.info("Trading loop stopped");
  await appendDailyLog(`[${new Date().toISOString()}] Trading engine stopped`);
}

export function stopTradingLoop(): void {
  shouldStop = true;
  log.info("Trading loop stop requested");
}
