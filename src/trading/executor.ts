/**
 * Trade Executor — place orders on Polymarket via the CLOB SDK.
 * Also handles balance checks and position queries.
 */

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createLogger } from "../logger.js";

const log = createLogger("executor");

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";

let cachedClient: ClobClient | null = null;

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function getClient(): Promise<ClobClient> {
  if (cachedClient) return cachedClient;

  const pk = getEnv("POLYMARKET_WALLET_PRIVATE_KEY");
  const proxy = getEnv("POLYMARKET_PROXY_ADDRESS");
  const key = getEnv("POLYMARKET_API_KEY");
  const secret = getEnv("POLYMARKET_API_SECRET");
  const passphrase = getEnv("POLYMARKET_API_PASSPHRASE");

  const formatted = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(formatted);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });

  const creds: ApiKeyCreds = { key, secret, passphrase };

  cachedClient = new ClobClient(CLOB_HOST, 137, signer, creds, 1, proxy);

  return cachedClient;
}

/**
 * Get USDC balance available for trading.
 */
export async function getBalance(): Promise<number> {
  try {
    const client = await getClient();
    const result = await client.getBalanceAllowance({ asset_type: "COLLATERAL" as never });
    // Balance is in 6-decimal USDC format
    const raw = parseFloat(result.balance ?? "0");
    return raw / 1_000_000;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Balance check failed: ${msg}`);
    return 0;
  }
}

export interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
}

/**
 * Get open positions from Data API.
 */
export async function getOpenPositions(): Promise<Position[]> {
  try {
    const proxy = getEnv("POLYMARKET_PROXY_ADDRESS");
    const response = await fetch(`${DATA_BASE}/positions?user=${proxy}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return [];

    const data = await response.json() as Array<{
      conditionId: string;
      title?: string;
      outcome: string;
      size: number;
      avgPrice: number;
      currentPrice?: number;
    }>;

    return (data ?? []).map((p) => ({
      conditionId: p.conditionId ?? "",
      title: p.title ?? "",
      outcome: p.outcome ?? "",
      size: p.size ?? 0,
      avgPrice: p.avgPrice ?? 0,
      currentPrice: p.currentPrice ?? p.avgPrice ?? 0,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Position fetch failed: ${msg}`);
    return [];
  }
}

/**
 * Place a market order on Polymarket.
 * Returns order ID on success, null on failure.
 */
export async function executeOrder(
  conditionId: string,
  side: "YES" | "NO",
  sizeUsd: number,
  tokenIds: [string, string],
  negRisk: boolean,
): Promise<string | null> {
  try {
    const client = await getClient();

    // YES = token index 0, NO = token index 1
    const tokenId = side === "YES" ? tokenIds[0] : tokenIds[1];

    if (!tokenId) {
      log.error(`No token ID for ${side} side`);
      return null;
    }

    log.info(`Placing ${side} order: $${sizeUsd.toFixed(2)} on ${conditionId.slice(0, 12)}... token=${tokenId.slice(0, 12)}...`);

    // Use market order (FOK) for immediate execution
    const result = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: sizeUsd,
        side: Side.BUY,
      },
      undefined,
      OrderType.FOK,
    ) as Record<string, unknown>;

    const orderId = (result.orderID ?? result.id ?? null) as string | null;
    const status = (result.status ?? "unknown") as string;

    if (orderId) {
      log.info(`Order placed: ${orderId} (status: ${status})`);
    } else {
      log.warn(`Order response: ${JSON.stringify(result).slice(0, 300)}`);
    }

    return orderId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Order execution failed: ${msg}`);
    return null;
  }
}
