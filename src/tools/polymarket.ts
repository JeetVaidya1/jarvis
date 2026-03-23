import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type {
  ApiKeyCreds,
  OrderBookSummary,
  OrderSummary,
  Trade,
} from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import Anthropic from "@anthropic-ai/sdk";

// ── API base URLs ──
// CLOB: trading, order book (SDK handles this)
// Gamma: market discovery, metadata (no auth, REST)
// Data: user positions, portfolio (no auth, REST)
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";

// ── Singleton client ──

let cachedClient: ClobClient | null = null;
let cachedCreds: ApiKeyCreds | null = null;

function getEnvOrNull(key: string): string | null {
  return process.env[key] ?? null;
}

function getRequiredEnv(): {
  privateKey: `0x${string}`;
  proxyAddress: string;
  apiKey: string | null;
  apiSecret: string | null;
  apiPassphrase: string | null;
} {
  const pk = getEnvOrNull("POLYMARKET_WALLET_PRIVATE_KEY");
  const proxy = getEnvOrNull("POLYMARKET_PROXY_ADDRESS");

  if (!pk || !proxy) {
    throw new Error(
      "Polymarket not configured. Set POLYMARKET_WALLET_PRIVATE_KEY and POLYMARKET_PROXY_ADDRESS in .env",
    );
  }

  const privateKey = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;

  return {
    privateKey,
    proxyAddress: proxy,
    apiKey: getEnvOrNull("POLYMARKET_API_KEY"),
    apiSecret: getEnvOrNull("POLYMARKET_API_SECRET"),
    apiPassphrase: getEnvOrNull("POLYMARKET_API_PASSPHRASE"),
  };
}

async function getClient(): Promise<ClobClient> {
  if (cachedClient) return cachedClient;

  const env = getRequiredEnv();

  // Create viem WalletClient as the signer (SDK supports both ethers v5 and viem)
  const account = privateKeyToAccount(env.privateKey);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // Use pre-configured creds if available, otherwise derive
  if (env.apiKey && env.apiSecret && env.apiPassphrase) {
    cachedCreds = {
      key: env.apiKey,
      secret: env.apiSecret,
      passphrase: env.apiPassphrase,
    };
  }

  if (!cachedCreds) {
    const tempClient = new ClobClient(CLOB_HOST, 137, signer);
    cachedCreds = await tempClient.createOrDeriveApiKey();
  }

  // signatureType 1 = POLY_PROXY (Magic/Google auth)
  cachedClient = new ClobClient(
    CLOB_HOST,
    137,
    signer,
    cachedCreds,
    1, // POLY_PROXY
    env.proxyAddress,
  );

  return cachedClient;
}

// ── Gamma API (market metadata, no auth) ──

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  description?: string;
  outcomes: string[];           // ["Yes", "No"]
  outcomePrices: string[];      // ["0.55", "0.45"]
  clobTokenIds: string[];       // [yesTokenId, noTokenId]
  volume: string;
  volumeNum?: number;
  endDate: string;
  endDateIso?: string;
  active: boolean;
  negRisk: boolean;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  acceptingOrders?: boolean;
  orderPriceMinTickSize?: string;
}

/**
 * Parse a JSON-encoded string array field from Gamma API.
 * e.g. "[\"0.55\", \"0.45\"]" → ["0.55", "0.45"]
 */
function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // Not valid JSON
    }
  }
  return [];
}

function getYesPrice(m: GammaMarket): number | null {
  const prices = parseJsonStringArray(m.outcomePrices);
  const val = prices[0];
  if (val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function getTokenIds(m: GammaMarket): string[] {
  return parseJsonStringArray(m.clobTokenIds);
}

async function gammaFetch(path: string): Promise<unknown> {
  const url = `${GAMMA_BASE}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gamma API ${response.status}: ${body}`);
  }

  return response.json();
}

// ── Tags (Gamma API, cached) ──

interface GammaTag {
  id: number;
  label: string;
  slug: string;
}

let cachedTags: GammaTag[] | null = null;
let tagsCachedAt = 0;
const TAGS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchTags(): Promise<GammaTag[]> {
  const now = Date.now();
  if (cachedTags && now - tagsCachedAt < TAGS_CACHE_TTL) {
    return cachedTags;
  }

  const data = (await gammaFetch("/tags?limit=100")) as GammaTag[];
  if (Array.isArray(data)) {
    cachedTags = data;
    tagsCachedAt = now;
  }

  return cachedTags ?? [];
}

function findTagId(tags: GammaTag[], query: string): number | null {
  const q = query.toLowerCase().trim();

  // Exact match on slug or label first
  const exact = tags.find(
    (t) => t.slug.toLowerCase() === q || t.label.toLowerCase() === q,
  );
  if (exact) return exact.id;

  // Partial match — query contained in label or slug
  const partial = tags.find(
    (t) =>
      t.slug.toLowerCase().includes(q) ||
      t.label.toLowerCase().includes(q),
  );
  if (partial) return partial.id;

  // Reverse partial — any word in query matches
  const words = q.split(/\s+/);
  const wordMatch = tags.find((t) =>
    words.some(
      (w) =>
        t.slug.toLowerCase().includes(w) ||
        t.label.toLowerCase().includes(w),
    ),
  );
  if (wordMatch) return wordMatch.id;

  return null;
}

export async function polymarketGetTags(): Promise<string> {
  try {
    const tags = await fetchTags();

    if (tags.length === 0) {
      return "No tags found.";
    }

    const formatted = tags
      .map((t) => `- **${t.label}** (slug: ${t.slug}, id: ${t.id})`)
      .join("\n");

    return `## Polymarket Tags (${tags.length})\n\n${formatted}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching tags: ${msg}`;
  }
}

export async function polymarketFindTagId(query: string): Promise<string> {
  try {
    const tags = await fetchTags();
    const tagId = findTagId(tags, query);

    if (tagId === null) {
      return `No tag found matching "${query}". Use polymarket_get_tags to see all available tags.`;
    }

    const tag = tags.find((t) => t.id === tagId);
    return `Found tag: **${tag?.label}** (id: ${tagId}, slug: ${tag?.slug})`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR finding tag: ${msg}`;
  }
}

// ── Data API (positions, portfolio, no auth) ──

interface DataPosition {
  asset: string;
  conditionId: string;
  market_slug?: string;
  title?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice?: number;
  initialValue: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
}

async function dataFetch(path: string): Promise<unknown> {
  const url = `${DATA_BASE}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Data API ${response.status}: ${body}`);
  }

  return response.json();
}

// ══════════════════════════════════════════════
// Exported tool functions
// ══════════════════════════════════════════════

// ── Positions (Data API) ──

export async function polymarketGetPositions(): Promise<string> {
  try {
    const env = getRequiredEnv();
    const data = (await dataFetch(
      `/positions?user=${env.proxyAddress}`,
    )) as DataPosition[];

    if (!Array.isArray(data) || data.length === 0) {
      return "No open positions.";
    }

    const formatted = data.map((pos) => {
      const size = pos.size;
      const entryPrice = pos.avgPrice;
      const currentPrice = pos.currentPrice ?? entryPrice;
      const pnl = pos.cashPnl ?? (currentPrice - entryPrice) * size;
      const pnlPct =
        pos.percentPnl ??
        (entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0);

      return [
        `**${pos.title || pos.market_slug || pos.conditionId}**`,
        `  Side: ${pos.outcome} | Size: ${size.toFixed(2)} shares`,
        `  Entry: $${entryPrice.toFixed(4)} | Current: $${currentPrice.toFixed(4)}`,
        `  P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
      ].join("\n");
    });

    return `## Open Positions (${data.length})\n\n${formatted.join("\n\n")}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching positions: ${msg}`;
  }
}

// ── Portfolio Summary (Data API) ──

export async function polymarketGetPortfolioSummary(): Promise<string> {
  try {
    const env = getRequiredEnv();

    // Try the /value endpoint first
    let totalValue: number | null = null;
    try {
      const valueData = (await dataFetch(
        `/value?user=${env.proxyAddress}`,
      )) as { value?: number; totalValue?: number };
      totalValue = valueData.value ?? valueData.totalValue ?? null;
    } catch {
      // Fall back to aggregating positions
    }

    const positions = (await dataFetch(
      `/positions?user=${env.proxyAddress}`,
    )) as DataPosition[];

    if (!Array.isArray(positions) || positions.length === 0) {
      return "No open positions. Portfolio is empty.";
    }

    let totalDeployed = 0;
    let totalPnl = 0;
    let wins = 0;

    for (const pos of positions) {
      const entryPrice = pos.avgPrice;
      const currentPrice = pos.currentPrice ?? entryPrice;
      const positionCost = pos.size * entryPrice;
      const pnl = pos.cashPnl ?? (currentPrice - entryPrice) * pos.size;

      totalDeployed += positionCost;
      totalPnl += pnl;
      if (pnl > 0) wins++;
    }

    const winRate =
      positions.length > 0
        ? ((wins / positions.length) * 100).toFixed(0)
        : "0";

    const lines = [
      `## Portfolio Summary`,
      "",
      `**Open Positions**: ${positions.length}`,
      `**Total Deployed**: $${totalDeployed.toFixed(2)} USDC`,
      `**Total P&L**: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      `**Win Rate**: ${winRate}% (${wins}/${positions.length} in profit)`,
    ];

    if (totalValue !== null) {
      lines.push(`**Portfolio Value**: $${totalValue.toFixed(2)}`);
    }

    lines.push(`**Address**: ${env.proxyAddress}`);

    return lines.join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching portfolio: ${msg}`;
  }
}

// ── Search Markets (Gamma API) ──

export async function polymarketSearch(
  query: string,
  filters?: { active?: boolean; limit?: number },
): Promise<string> {
  const active = filters?.active ?? true;
  const limit = Math.min(filters?.limit ?? 20, 50);

  try {
    let markets: GammaMarket[] = [];

    // Primary: search events by title (best keyword matching)
    try {
      const events = (await gammaFetch(
        `/events?closed=${!active}&limit=10&title=${encodeURIComponent(query)}`,
      )) as Array<{ title?: string; markets?: GammaMarket[] }>;
      if (Array.isArray(events)) {
        for (const event of events) {
          if (event.markets) markets.push(...event.markets);
        }
      }
    } catch {
      // continue
    }

    // Fallback: direct market search
    if (markets.length === 0) {
      try {
        const data = (await gammaFetch(
          `/markets?closed=${!active}&limit=${limit}&q=${encodeURIComponent(query)}`,
        )) as GammaMarket[];
        if (Array.isArray(data)) {
          // Filter to only markets whose question contains the query
          const q = query.toLowerCase();
          markets = data.filter((m) => m.question.toLowerCase().includes(q));
        }
      } catch {
        // continue
      }
    }

    if (markets.length === 0) {
      return `No markets found for "${query}".`;
    }

    return formatMarkets(markets.slice(0, limit), query);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR searching markets: ${msg}`;
  }
}

// ── Active Markets by Category (Gamma API) ──

export async function polymarketGetActiveMarkets(
  category?: string,
  timeframe?: string,
): Promise<string> {
  try {
    // Resolve tag query to a numeric tag_id
    const tagQuery = timeframe === "5min" ? "5min" : category;
    let tagId: number | null = null;
    let tagLabel = "";

    if (tagQuery) {
      const tags = await fetchTags();
      tagId = findTagId(tags, tagQuery);
      const matchedTag = tagId !== null ? tags.find((t) => t.id === tagId) : undefined;
      tagLabel = matchedTag?.label ?? tagQuery;
    }

    let path: string;
    if (tagId !== null) {
      path = `/markets?tag_id=${tagId}&active=true&closed=false&limit=20`;
    } else if (tagQuery) {
      // Fallback: try slug-based search if no tag ID found
      path = `/markets?slug=${encodeURIComponent(tagQuery.toLowerCase())}&closed=false&limit=20`;
    } else {
      path = "/markets?closed=false&order=volume&ascending=false&limit=20";
    }

    let data = (await gammaFetch(path)) as GammaMarket[];

    if (!Array.isArray(data) || data.length === 0) {
      const label = timeframe === "5min"
        ? "5-minute"
        : category
          ? `"${category}"`
          : "active";
      return `No ${label} markets found.${tagId === null && tagQuery ? ` Tag "${tagQuery}" not found — use polymarket_get_tags to see available tags.` : ""}`;
    }

    // Sort by volume descending
    data = [...data].sort((a, b) => {
      const volA = parseFloat(a.volume || "0");
      const volB = parseFloat(b.volume || "0");
      return volB - volA;
    });

    const title = timeframe === "5min"
      ? `5-Minute Markets (tag: ${tagLabel})`
      : category
        ? `${tagLabel} Markets`
        : "Top Markets by Volume";

    return formatMarkets(data, undefined, title);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching active markets: ${msg}`;
  }
}

function formatMarkets(
  markets: GammaMarket[],
  query?: string,
  title?: string,
): string {
  const heading = title
    ? `## ${title}`
    : query
      ? `## Markets matching "${query}"`
      : "## Markets";

  const formatted = markets.map((m, i) => {
    const yesPrice = getYesPrice(m);
    const yesProb = yesPrice !== null ? (yesPrice * 100).toFixed(1) : "?";
    const volume = m.volume
      ? `$${parseFloat(m.volume).toLocaleString()}`
      : "N/A";
    const endDate = m.endDate ?? m.endDateIso;
    const endStr = endDate ? new Date(endDate).toLocaleDateString() : "N/A";

    return `${i + 1}. **${m.question}**\n   YES: ${yesProb}% | Volume: ${volume} | Ends: ${endStr}\n   ID: ${m.conditionId}`;
  });

  return `${heading}\n\n${formatted.join("\n\n")}`;
}

// ── Market Detail (SDK + Gamma) ──

export async function polymarketGetMarket(
  conditionId: string,
): Promise<string> {
  try {
    // Use CLOB SDK as primary source (Gamma conditionId lookup is unreliable)
    const client = await getClient();
    const clobData = await client.getMarket(conditionId) as Record<string, unknown>;

    if (!clobData || !clobData.question) {
      return `No market found for condition ID: ${conditionId}`;
    }

    const question = clobData.question as string;
    const description = (clobData.description as string) ?? "";
    const clobTokens = (clobData.tokens ?? []) as Array<{
      token_id: string;
      outcome: string;
      price: number;
    }>;

    const yesToken = clobTokens.find((t) => t.outcome === "Yes");
    const noToken = clobTokens.find((t) => t.outcome === "No");
    const yesPrice = yesToken?.price ?? null;
    const noPrice = noToken?.price ?? null;
    const yesTokenId = yesToken?.token_id;
    const noTokenId = noToken?.token_id;

    const endDate = (clobData.end_date_iso ?? clobData.endDate) as string | undefined;
    const endStr = endDate ? new Date(endDate).toLocaleDateString() : "N/A";
    const volume = clobData.volume
      ? `$${parseFloat(clobData.volume as string).toLocaleString()}`
      : "N/A";
    const negRisk = clobData.neg_risk ?? clobData.negRisk;
    const acceptingOrders = clobData.accepting_orders ?? clobData.acceptingOrders;
    const tickSize = clobData.minimum_tick_size ?? clobData.orderPriceMinTickSize;

    return [
      `## ${question}`,
      "",
      description
        ? `${description.slice(0, 300)}${description.length > 300 ? "..." : ""}`
        : "",
      "",
      `**YES**: $${yesPrice?.toFixed(4) ?? "?"} (${yesPrice ? (yesPrice * 100).toFixed(1) : "?"}%)`,
      `**NO**: $${noPrice?.toFixed(4) ?? "?"} (${noPrice ? (noPrice * 100).toFixed(1) : "?"}%)`,
      `**Volume**: ${volume}`,
      `**Tick Size**: ${tickSize ?? "N/A"}`,
      `**Ends**: ${endStr}`,
      `**Accepting Orders**: ${acceptingOrders ?? "unknown"}`,
      `**Neg Risk**: ${negRisk ?? false}`,
      `**Condition ID**: ${conditionId}`,
      yesTokenId ? `**YES Token ID**: ${yesTokenId}` : "",
      noTokenId ? `**NO Token ID**: ${noTokenId}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching market ${conditionId}: ${msg}`;
  }
}

// ── Order Book (SDK) ──

export async function polymarketGetOrderbook(
  tokenId: string,
): Promise<string> {
  try {
    const client = await getClient();
    const book: OrderBookSummary = await client.getOrderBook(tokenId);

    const formatEntries = (entries: OrderSummary[], label: string) => {
      if (!entries || entries.length === 0) return `  ${label}: (empty)`;
      return (
        `  ${label}:\n` +
        entries
          .slice(0, 5)
          .map(
            (e) =>
              `    $${parseFloat(e.price).toFixed(4)} — ${parseFloat(e.size).toFixed(2)} shares`,
          )
          .join("\n")
      );
    };

    const spread =
      book.asks?.[0] && book.bids?.[0]
        ? (parseFloat(book.asks[0].price) - parseFloat(book.bids[0].price)).toFixed(4)
        : "N/A";

    return [
      `## Order Book for ${tokenId}`,
      "",
      `**Spread**: $${spread}`,
      `**Tick Size**: ${book.tick_size}`,
      `**Last Trade**: $${book.last_trade_price}`,
      "",
      formatEntries(book.bids ?? [], "Bids"),
      formatEntries(book.asks ?? [], "Asks"),
    ].join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching orderbook: ${msg}`;
  }
}

// ── Place Order (SDK) ──

export interface PlaceOrderParams {
  conditionId: string;
  side: "YES" | "NO";
  size: number;
  price?: number;
  orderType: "MARKET" | "LIMIT";
  dryRun?: boolean;
}

export async function polymarketPlaceOrder(
  params: PlaceOrderParams,
): Promise<string> {
  const { conditionId, side, size, price, orderType, dryRun } = params;

  try {
    // Get market info from Gamma
    const gammaData = (await gammaFetch(
      `/markets?conditionId=${conditionId}`,
    )) as GammaMarket[];
    const marketData = Array.isArray(gammaData) ? gammaData[0] : undefined;

    if (!marketData) {
      return `ERROR: Market not found for condition ID: ${conditionId}`;
    }

    // Resolve token ID and price from Gamma response (JSON string fields)
    const tokenIdx = side === "YES" ? 0 : 1;
    const allTokenIds = getTokenIds(marketData);
    const tokenId = allTokenIds[tokenIdx];

    if (!tokenId) {
      return `ERROR: Could not find ${side} token ID for market ${conditionId}`;
    }

    const client = await getClient();

    // Get live price from CLOB
    const allPrices = parseJsonStringArray(marketData.outcomePrices);
    let currentPrice = allPrices[tokenIdx] !== undefined
      ? parseFloat(allPrices[tokenIdx] ?? "0")
      : 0.5;
    try {
      const priceData = await client.getPrice(tokenId, "BUY");
      if (priceData?.price) currentPrice = parseFloat(priceData.price);
    } catch {
      // Use Gamma price
    }

    const orderPrice =
      orderType === "LIMIT" && price !== undefined ? price : currentPrice;

    // Auto-log regardless of dryRun
    const { memoryUpdate } = await import("./memory-tool.js");

    if (dryRun) {
      const estimatedShares = orderPrice > 0 ? size / orderPrice : 0;

      const logEntry = `[DRY RUN] ${new Date().toISOString()} | ${side} ${marketData.question} | $${size} @ $${orderPrice.toFixed(4)} | ${orderType}`;
      await memoryUpdate(logEntry, "append");

      return [
        `## DRY RUN — Order Simulation`,
        "",
        `**Market**: ${marketData.question}`,
        `**Side**: ${side}`,
        `**Order Type**: ${orderType}`,
        `**Size**: $${size.toFixed(2)} USDC`,
        `**Price**: $${orderPrice.toFixed(4)} (${(orderPrice * 100).toFixed(1)}%)`,
        `**Estimated Shares**: ${estimatedShares.toFixed(2)}`,
        `**Current Market Price**: $${currentPrice.toFixed(4)}`,
        `**Token ID**: ${tokenId}`,
        "",
        `This is a simulation. No order was placed.`,
        `To execute, set dryRun: false.`,
      ].join("\n");
    }

    // Place real order via SDK
    let result: Record<string, unknown>;

    if (orderType === "MARKET") {
      // Market order: use createAndPostMarketOrder
      result = (await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: size,
          side: Side.BUY,
        },
        undefined,
        OrderType.FOK,
      )) as Record<string, unknown>;
    } else {
      // Limit order: use createAndPostOrder
      result = (await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: orderPrice,
          size: orderPrice > 0 ? size / orderPrice : size,
          side: Side.BUY,
        },
        undefined,
        OrderType.GTC,
      )) as Record<string, unknown>;
    }

    const orderId = (result.orderID ?? result.id ?? "unknown") as string;
    const status = (result.status ?? "submitted") as string;

    const logEntry = `[TRADE] ${new Date().toISOString()} | ${side} ${marketData.question} | $${size} @ $${orderPrice.toFixed(4)} | ${orderType} | ID: ${orderId}`;
    await memoryUpdate(logEntry, "append");

    return [
      `## Order Placed`,
      "",
      `**Market**: ${marketData.question}`,
      `**Side**: ${side}`,
      `**Size**: $${size.toFixed(2)} USDC`,
      `**Price**: $${orderPrice.toFixed(4)}`,
      `**Order ID**: ${orderId}`,
      `**Status**: ${status}`,
    ].join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR placing order: ${msg}`;
  }
}

// ── Cancel Order (SDK) ──

export async function polymarketCancelOrder(
  orderId: string,
): Promise<string> {
  try {
    const client = await getClient();
    await client.cancelOrder({ orderID: orderId });
    return `Order ${orderId} cancelled successfully.`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR cancelling order ${orderId}: ${msg}`;
  }
}

// ── Trades (SDK) ──

export async function polymarketGetTrades(
  market?: string,
): Promise<string> {
  try {
    const client = await getClient();
    const params = market ? { market } : undefined;
    const trades: Trade[] = await client.getTrades(params);

    if (!trades || trades.length === 0) {
      return "No recent trades.";
    }

    const formatted = trades.slice(0, 10).map((t, i) => {
      const size = parseFloat(t.size);
      const price = parseFloat(t.price);
      const time = new Date(t.match_time).toLocaleString();

      return `${i + 1}. ${t.side} ${t.outcome} — ${size.toFixed(2)} shares @ $${price.toFixed(4)}\n   ${time} | Status: ${t.status} | ${t.trader_side}`;
    });

    return `## Recent Trades\n\n${formatted.join("\n\n")}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching trades: ${msg}`;
  }
}

// ── Analyze Market (Claude Opus) ──

export async function polymarketAnalyzeMarket(
  conditionId: string,
): Promise<string> {
  try {
    // Gather market data
    const marketInfo = await polymarketGetMarket(conditionId);

    // Get order book for the YES token
    const gammaData = (await gammaFetch(
      `/markets?condition_id=${conditionId}`,
    )) as GammaMarket[];
    const market = Array.isArray(gammaData) ? gammaData[0] : undefined;

    let orderbookInfo = "";
    if (market?.clobTokenIds?.[0]) {
      orderbookInfo = await polymarketGetOrderbook(market.clobTokenIds[0]);
    }

    // Build analysis prompt
    const prompt = `You are a prediction market analyst. Analyze this Polymarket market and provide a structured assessment.

## Market Data
${marketInfo}

## Order Book
${orderbookInfo}

Provide your analysis in this exact format:

**Current Probability**: [YES price as %]
**Your Estimated True Probability**: [your estimate as %]
**Edge**: [difference in percentage points]
**Recommendation**: [BUY YES / BUY NO / NO TRADE]
**Confidence**: [LOW / MEDIUM / HIGH]
**Reasoning**: [2-3 sentences explaining your analysis]
**Risk Factors**: [bullet list of key risks]
**Suggested Position Size**: [$ amount, considering the edge and confidence]`;

    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const analysis = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return `## Market Analysis: ${market?.question ?? conditionId}\n\n${analysis}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR analyzing market: ${msg}`;
  }
}
