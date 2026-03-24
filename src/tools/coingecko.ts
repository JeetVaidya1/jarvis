/**
 * CoinGecko API — deep crypto market data.
 * No API key required for free tier.
 * https://api.coingecko.com/api/v3
 */

const BASE_URL = "https://api.coingecko.com/api/v3";

async function cgFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) throw new Error("Rate limited by CoinGecko — try again in a minute.");
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

function pct(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function usd(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(4)}`;
}

interface TrendingItem {
  item: {
    name: string;
    symbol: string;
    market_cap_rank: number | null;
    price_btc: number;
    thumb: string;
  };
}

/**
 * Top 7 trending coins on CoinGecko right now.
 */
export async function cryptoTrending(): Promise<string> {
  const data = await cgFetch<{ coins: TrendingItem[] }>("/search/trending");
  const lines = data.coins.slice(0, 7).map((c, i) => {
    const { name, symbol, market_cap_rank, price_btc } = c.item;
    const rank = market_cap_rank ? `#${market_cap_rank}` : "unranked";
    return `${i + 1}. **${name}** (${symbol.toUpperCase()}) — MCap rank: ${rank} | Price: ${price_btc.toExponential(4)} BTC`;
  });
  return `**Trending on CoinGecko:**\n${lines.join("\n")}`;
}

interface CoinMarket {
  market_cap_rank: number;
  name: string;
  symbol: string;
  current_price: number;
  price_change_percentage_24h: number | null;
  market_cap: number | null;
  total_volume: number | null;
}

/**
 * Crypto market overview — top coins by market cap, volume, or 24h change.
 */
export async function cryptoMarkets(
  vs_currency = "usd",
  order = "market_cap_desc",
  per_page = 10,
): Promise<string> {
  const coins = await cgFetch<CoinMarket[]>("/coins/markets", {
    vs_currency,
    order,
    per_page: String(Math.min(per_page, 25)),
    price_change_percentage: "24h",
  });

  const lines = coins.map((c) => {
    return `${c.market_cap_rank ?? "?"}. **${c.name}** (${c.symbol.toUpperCase()}) — ${usd(c.current_price)} | 24h: ${pct(c.price_change_percentage_24h)} | MCap: ${usd(c.market_cap)}`;
  });

  const orderLabel: Record<string, string> = {
    market_cap_desc: "market cap",
    volume_desc: "volume",
    price_change_percentage_24h_desc: "24h gain",
  };

  return `**Top ${coins.length} coins by ${orderLabel[order] ?? order} (${vs_currency.toUpperCase()}):**\n${lines.join("\n")}`;
}

interface CoinDetail {
  name: string;
  symbol: string;
  description: { en: string };
  links: { homepage: string[]; twitter_screen_name: string; subreddit_url: string };
  market_data: {
    current_price: { usd: number };
    market_cap: { usd: number };
    price_change_percentage_24h: number;
    price_change_percentage_7d: number;
    ath: { usd: number };
    ath_change_percentage: { usd: number };
    atl: { usd: number };
    circulating_supply: number;
    total_supply: number | null;
    max_supply: number | null;
  };
}

/**
 * Deep info on a specific coin.
 */
export async function cryptoCoinInfo(coin_id: string): Promise<string> {
  const c = await cgFetch<CoinDetail>(`/coins/${coin_id}`, {
    localization: "false",
    tickers: "false",
    community_data: "false",
    developer_data: "false",
  });

  const md = c.market_data;
  const desc = c.description.en
    ? c.description.en.replace(/<[^>]+>/g, "").slice(0, 200) + "…"
    : "No description.";
  const homepage = c.links.homepage[0] ?? "";
  const twitter = c.links.twitter_screen_name ? `@${c.links.twitter_screen_name}` : "";

  return [
    `**${c.name} (${c.symbol.toUpperCase()})**`,
    `Price: ${usd(md.current_price.usd)} | 24h: ${pct(md.price_change_percentage_24h)} | 7d: ${pct(md.price_change_percentage_7d)}`,
    `Market cap: ${usd(md.market_cap.usd)}`,
    `ATH: ${usd(md.ath.usd)} (${pct(md.ath_change_percentage.usd)} from ATH) | ATL: ${usd(md.atl.usd)}`,
    `Supply: ${md.circulating_supply.toLocaleString("en-US", { maximumFractionDigits: 0 })} circulating${md.max_supply ? ` / ${md.max_supply.toLocaleString("en-US", { maximumFractionDigits: 0 })} max` : ""}`,
    `${homepage}${twitter ? ` | Twitter: ${twitter}` : ""}`,
    ``,
    desc,
  ].join("\n");
}

/**
 * Top DeFi tokens by market cap.
 */
export async function cryptoDefiTvl(top = 10): Promise<string> {
  const coins = await cgFetch<CoinMarket[]>("/coins/markets", {
    vs_currency: "usd",
    category: "decentralized-finance-defi",
    order: "market_cap_desc",
    per_page: String(Math.min(top, 25)),
    price_change_percentage: "24h",
  });

  if (coins.length === 0) return "No DeFi data available.";

  const lines = coins.map((c, i) => {
    return `${i + 1}. **${c.name}** (${c.symbol.toUpperCase()}) — ${usd(c.current_price)} | 24h: ${pct(c.price_change_percentage_24h)} | MCap: ${usd(c.market_cap)}`;
  });

  return `**Top ${coins.length} DeFi tokens by market cap:**\n${lines.join("\n")}`;
}
