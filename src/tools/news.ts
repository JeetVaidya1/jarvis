/**
 * NewsAPI integration — top headlines and keyword search.
 * Requires NEWS_API_KEY env var. Free tier: 100 req/day.
 * https://newsapi.org/v2
 */

const BASE_URL = "https://newsapi.org/v2";

function getApiKey(): string {
  const key = process.env.NEWS_API_KEY;
  if (!key) throw new Error("NEWS_API_KEY env var is not set. Add it to your .env file.");
  return key;
}

interface NewsArticle {
  title: string;
  description: string | null;
  url: string;
  source: { name: string };
  publishedAt: string;
}

interface NewsResponse {
  status: string;
  totalResults?: number;
  articles?: NewsArticle[];
  message?: string;
}

function formatArticle(a: NewsArticle, i: number): string {
  const date = new Date(a.publishedAt).toLocaleString("en-CA", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Vancouver",
  });
  const desc = a.description ? `\n    ${a.description.slice(0, 120)}` : "";
  return `${i + 1}. [${a.source.name}] ${a.title}${desc}\n    ${date} — ${a.url}`;
}

/**
 * Top headlines by category and country.
 */
export async function newsHeadlines(category?: string, country = "us"): Promise<string> {
  const key = getApiKey();
  const params = new URLSearchParams({ country, apiKey: key, pageSize: "10" });
  if (category) params.set("category", category);

  const res = await fetch(`${BASE_URL}/top-headlines?${params.toString()}`);
  const data = (await res.json()) as NewsResponse;

  if (data.status !== "ok") return `NewsAPI error: ${data.message ?? "unknown error"}`;
  if (!data.articles || data.articles.length === 0) return "No headlines found.";

  const header = category
    ? `**Top headlines — ${category} (${country.toUpperCase()}):**`
    : `**Top headlines (${country.toUpperCase()}):**`;
  return `${header}\n${data.articles.map(formatArticle).join("\n\n")}`;
}

/**
 * Full-text news search.
 */
export async function newsSearch(
  query: string,
  from?: string,
  to?: string,
  pageSize = 10,
): Promise<string> {
  const key = getApiKey();
  const params = new URLSearchParams({ q: query, apiKey: key, pageSize: String(pageSize), sortBy: "relevancy" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const res = await fetch(`${BASE_URL}/everything?${params.toString()}`);
  const data = (await res.json()) as NewsResponse;

  if (data.status !== "ok") return `NewsAPI error: ${data.message ?? "unknown error"}`;
  if (!data.articles || data.articles.length === 0) return `No news found for: ${query}`;

  const total = data.totalResults ?? 0;
  return `**News: "${query}" (${total} total, showing ${data.articles.length}):**\n${data.articles.map(formatArticle).join("\n\n")}`;
}
