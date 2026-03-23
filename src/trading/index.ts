/**
 * Trading module public API.
 */

export {
  startTradingLoop,
  stopTradingLoop,
  runTradingCycle,
  isEngineRunning,
  getTradeHistory,
  DEFAULT_CONFIG,
  type TradingConfig,
  type TradeRecord,
} from "./engine.js";

export { scanMarkets, type ScoredMarket } from "./scanner.js";
export { forecast, type Prediction } from "./forecaster.js";
export { calculateEdge, sizePosition } from "./risk.js";
export { executeOrder, getBalance, getOpenPositions } from "./executor.js";
