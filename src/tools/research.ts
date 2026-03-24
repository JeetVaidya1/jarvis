/**
 * Research tools — Brave Search, Firecrawl, and Perplexity.
 *
 * Brave Search: real web results, no tracking. Requires BRAVE_API_KEY.
 * Firecrawl: scrape/crawl websites into clean markdown. Requires FIRECRAWL_API_KEY.
 * Perplexity: AI-powered search with citations. Requires PERPLEXITY_API_KEY.
 */

const MAX_CONTENT = 8_000;

// ── Brave Search ──

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  error?: { message: string };
}

function getBraveKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY env var not set. Get a key at https://brave.com/search/api/");
  return key;
}

export async function braveSearch(query: string, count = 10): Promise<string> {
  const key = getBraveKey();
  const capped = Math.min(Math.max(1, count), 20);

  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
    q: query,
    count: String(capped),
    text_decorations: "false",
    search_lang: "en",
    country: "US",
  }).toString()}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    return `Brave Search error: HTTP ${res.status} ${res.statusText}`;
  }

  const data = (await res.json()) as BraveSearchResponse;

  if (data.error) {
    return `Brave Search error: ${data.error.message}`;
  }

  const results = data.web?.results ?? [];
  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const formatted = results
    .map((r, i) => {
      const age = r.age ? ` (${r.age})` : "";
      const desc = r.description ? `\n   ${r.description.slice(0, 200)}` : "";
      return `${i + 1}. **${r.title}**${age}\n   ${r.url}${desc}`;
    })
    .join("\n\n");

  return `**Brave Search results for "${query}":**\n\n${formatted}`;
}

// ── Firecrawl ──

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

interface FirecrawlCrawlResponse {
  success: boolean;
  id?: string;
  status?: string;
  data?: Array<{
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string };
  }>;
  error?: string;
}

function getFirecrawlKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY env var not set. Get a key at https://firecrawl.dev");
  return key;
}

export async function firecrawlScrape(url: string): Promise<string> {
  const key = getFirecrawlKey();

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    return `Firecrawl error: HTTP ${res.status} ${res.statusText}`;
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    return `Firecrawl error: ${data.error ?? "scrape failed"}`;
  }

  const meta = data.data.metadata;
  const title = meta?.title ? `# ${meta.title}\n` : "";
  const source = meta?.sourceURL ? `Source: ${meta.sourceURL}\n\n` : "";
  const content = data.data.markdown ?? "";
  const truncated = content.length > MAX_CONTENT
    ? content.slice(0, MAX_CONTENT) + "\n...(truncated)"
    : content;

  return `${title}${source}${truncated || "(no content)"}`;
}

export async function firecrawlCrawl(
  startUrl: string,
  maxPages = 5,
): Promise<string> {
  const key = getFirecrawlKey();
  const capped = Math.min(Math.max(1, maxPages), 20);

  // Start crawl
  const crawlRes = await fetch("https://api.firecrawl.dev/v1/crawl", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: startUrl,
      limit: capped,
      scrapeOptions: { formats: ["markdown"] },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!crawlRes.ok) {
    return `Firecrawl crawl error: HTTP ${crawlRes.status} ${crawlRes.statusText}`;
  }

  const crawlData = (await crawlRes.json()) as FirecrawlCrawlResponse;
  if (!crawlData.success || !crawlData.id) {
    return `Firecrawl crawl error: ${crawlData.error ?? "failed to start crawl"}`;
  }

  // Poll for results (max 60s)
  const jobId = crawlData.id;
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 3_000));

    const statusRes = await fetch(`https://api.firecrawl.dev/v1/crawl/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!statusRes.ok) break;

    const status = (await statusRes.json()) as FirecrawlCrawlResponse;
    if (status.status === "completed" && status.data) {
      const pages = status.data
        .slice(0, capped)
        .map((p, i) => {
          const title = p.metadata?.title ?? p.metadata?.sourceURL ?? `Page ${i + 1}`;
          const url = p.metadata?.sourceURL ?? "";
          const content = (p.markdown ?? "").slice(0, 2_000);
          return `## ${title}\n${url}\n\n${content}`;
        })
        .join("\n\n---\n\n");

      return `**Crawl results for ${startUrl} (${status.data.length} pages):**\n\n${pages}`;
    }

    if (status.status === "failed") {
      return `Firecrawl crawl failed for ${startUrl}`;
    }
  }

  return `Firecrawl crawl timed out after 60s. Job ID: ${jobId}`;
}

// ── Perplexity ──

interface PerplexityMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface PerplexityResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  citations?: string[];
  error?: { message: string };
}

function getPerplexityKey(): string {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY env var not set. Get a key at https://perplexity.ai/api");
  return key;
}

export async function perplexitySearch(
  query: string,
  model = "sonar",
): Promise<string> {
  const key = getPerplexityKey();

  const messages: PerplexityMessage[] = [
    {
      role: "system",
      content:
        "You are a research assistant. Answer concisely with facts. Always cite sources.",
    },
    { role: "user", content: query },
  ];

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    return `Perplexity error: HTTP ${res.status} ${res.statusText}`;
  }

  const data = (await res.json()) as PerplexityResponse;

  if (data.error) {
    return `Perplexity error: ${data.error.message}`;
  }

  const answer = data.choices?.[0]?.message?.content ?? "";
  if (!answer) return "Perplexity returned no answer.";

  const citations = data.citations ?? [];
  const citationBlock =
    citations.length > 0
      ? `\n\n**Sources:**\n${citations.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "";

  return `**Perplexity (${model}):**\n\n${answer}${citationBlock}`;
}
