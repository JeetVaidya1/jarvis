const MAX_CONTENT_LENGTH = 10_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface DdgAbstractResult {
  Abstract: string;
  AbstractURL: string;
  AbstractText: string;
  Heading: string;
  RelatedTopics: Array<{
    Text?: string;
    FirstURL?: string;
  }>;
}

export async function webSearch(
  query: string,
  numResults: number = 5,
): Promise<string> {
  const capped = Math.min(Math.max(1, numResults), 10);

  try {
    const results: SearchResult[] = [];

    // DuckDuckGo instant answer API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddgResponse = await fetch(ddgUrl);

    if (ddgResponse.ok) {
      const data = (await ddgResponse.json()) as DdgAbstractResult;

      if (data.Abstract) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL || "",
          snippet: data.AbstractText || data.Abstract,
        });
      }

      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= capped) break;
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.split(" - ")[0] ?? topic.Text,
              url: topic.FirstURL,
              snippet: topic.Text,
            });
          }
        }
      }
    }

    // DuckDuckGo HTML scrape for more results
    if (results.length < capped) {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const htmlResponse = await fetch(htmlUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      });

      if (htmlResponse.ok) {
        const html = await htmlResponse.text();
        const resultPattern =
          /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;

        let match;
        while (
          (match = resultPattern.exec(html)) !== null &&
          results.length < capped
        ) {
          const url = match[1] ?? "";
          const title = (match[2] ?? "").replace(/<[^>]*>/g, "").trim();
          const snippet = (match[3] ?? "").replace(/<[^>]*>/g, "").trim();

          if (url && title) {
            // Deduplicate by URL
            if (!results.some((r) => r.url === url)) {
              results.push({ title, url, snippet });
            }
          }
        }
      }
    }

    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
      )
      .join("\n\n");

    return `Search results for "${query}":\n\n${formatted}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR searching for "${query}": ${msg}`;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function webFetch(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return `ERROR fetching ${url}: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    let content: string;
    if (contentType.includes("json")) {
      try {
        const parsed = JSON.parse(body);
        content = JSON.stringify(parsed, null, 2);
      } catch {
        content = body;
      }
    } else if (contentType.includes("html")) {
      content = stripHtml(body);
    } else {
      content = body;
    }

    // Extract title from HTML
    let title = url;
    const titleMatch = body.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim();
    }

    const cleaned = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    const truncated =
      cleaned.length > MAX_CONTENT_LENGTH
        ? cleaned.slice(0, MAX_CONTENT_LENGTH) + "\n...(truncated)"
        : cleaned;

    return `Title: ${title}\nURL: ${url}\n\n${truncated}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching ${url}: ${msg}`;
  }
}

interface CoinGeckoPrice {
  [coin: string]: {
    usd?: number;
    usd_24h_change?: number;
  } | undefined;
}

const CRYPTO_SYMBOLS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  MATIC: "matic-network",
  DOGE: "dogecoin",
  ADA: "cardano",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  UNI: "uniswap",
  ATOM: "cosmos",
  XRP: "ripple",
  LTC: "litecoin",
  NEAR: "near",
  ARB: "arbitrum",
  OP: "optimism",
  SUI: "sui",
  APT: "aptos",
  SEI: "sei-network",
  TIA: "celestia",
};

export async function webGetPrice(asset: string): Promise<string> {
  const upper = asset.toUpperCase().trim();
  const coinId = CRYPTO_SYMBOLS[upper];

  if (coinId) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return `ERROR fetching ${upper} price: HTTP ${response.status}`;
      }

      const data = (await response.json()) as CoinGeckoPrice;
      const priceData = data[coinId];

      if (priceData?.usd !== undefined) {
        const price = priceData.usd;
        const change = priceData.usd_24h_change;
        const changeStr =
          change !== undefined
            ? ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% 24h)`
            : "";
        const timestamp = new Date().toISOString();
        return `${upper}: $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}${changeStr}\nAs of: ${timestamp}`;
      }

      return `Could not find price data for ${upper}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `ERROR fetching ${upper} price: ${msg}`;
    }
  }

  // Stock — scrape Yahoo Finance
  try {
    const ticker = upper.replace(/[^A-Z0-9.]/g, "");
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return `ERROR fetching ${ticker} price: HTTP ${response.status}. Try using crypto symbol or a valid stock ticker.`;
    }

    const data = (await response.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            shortName?: string;
          };
        }>;
      };
    };

    const meta = data.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice !== undefined) {
      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose;
      let changeStr = "";
      if (prevClose !== undefined && prevClose > 0) {
        const change = ((price - prevClose) / prevClose) * 100;
        changeStr = ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% today)`;
      }
      const name = meta.shortName ?? ticker;
      const timestamp = new Date().toISOString();
      return `${name} (${ticker}): $${price.toFixed(2)}${changeStr}\nAs of: ${timestamp}`;
    }

    return `Could not find price data for ticker: ${ticker}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching stock price for ${upper}: ${msg}`;
  }
}
