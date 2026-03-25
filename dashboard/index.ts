/**
 * Dashboard entry point.
 * Starts the Jarvis Command Center Express server.
 * Also re-exports logEvent and upsertSubagent for use throughout Jarvis.
 */

export { logEvent, upsertSubagent } from "./logger.js";
export type { DashboardEvent, SubagentRecord } from "./logger.js";

import { startServer } from "./server.js";

startServer();
