/**
 * Alpha Vantage — stock fundamentals, earnings, income statements.
 * Requires ALPHA_VANTAGE_KEY env var. Free tier: 25 req/day.
 * https://www.alphavantage.co/query
 */

const BASE_URL = "https://www.alphavantage.co/query";

function getApiKey(): string {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) throw new Error("ALPHA_VANTAGE_KEY env var is not set. Add it to your .env file. Free key at https://www.alphavantage.co/support/#api-key");
  return key;
}

async function avFetch(params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = getApiKey();
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries({ ...params, apikey: key })) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Alpha Vantage ${res.status}: ${res.statusText}`);
  const data = await res.json() as Record<string, unknown>;

  // Rate limit indicator
  const note = data.Note ?? data.Information ?? "";
  if (typeof note === "string" && note.includes("Thank you for using Alpha Vantage")) {
    throw new Error("Alpha Vantage rate limit hit (25 req/day on free tier). Try again tomorrow or upgrade.");
  }

  return data;
}

function fmtNum(v: unknown, prefix = "", suffix = ""): string {
  if (v == null || v === "None" || v === "-") return "N/A";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (Math.abs(n) >= 1_000_000_000) return `${prefix}${(n / 1_000_000_000).toFixed(2)}B${suffix}`;
  if (Math.abs(n) >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(2)}M${suffix}`;
  return `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
}

/**
 * Company overview — key metrics snapshot.
 */
export async function stockOverview(symbol: string): Promise<string> {
  const data = await avFetch({ function: "OVERVIEW", symbol: symbol.toUpperCase() });

  if (!data.Symbol) return `No data found for ${symbol.toUpperCase()}. Check the ticker symbol.`;

  const desc = typeof data.Description === "string"
    ? data.Description.slice(0, 200) + "…"
    : "No description.";

  return [
    `**${data.Name} (${data.Symbol}) — ${data.Exchange}**`,
    `Sector: ${data.Sector ?? "N/A"} | Industry: ${data.Industry ?? "N/A"}`,
    `Market cap: ${fmtNum(data.MarketCapitalization, "$")}`,
    `P/E: ${data.PERatio ?? "N/A"} | Forward P/E: ${data.ForwardPE ?? "N/A"} | EPS: $${data.EPS ?? "N/A"}`,
    `Dividend yield: ${data.DividendYield != null && data.DividendYield !== "None" ? `${(Number(data.DividendYield) * 100).toFixed(2)}%` : "N/A"}`,
    `52-week: $${data["52WeekLow"] ?? "N/A"} – $${data["52WeekHigh"] ?? "N/A"}`,
    `Beta: ${data.Beta ?? "N/A"} | Analyst target: $${data.AnalystTargetPrice ?? "N/A"}`,
    ``,
    desc,
  ].join("\n");
}

interface QuarterlyEarning {
  fiscalDateEnding: string;
  reportedEPS: string;
  estimatedEPS: string;
  surprise: string;
  surprisePercentage: string;
}

/**
 * Last 4 quarters of earnings vs estimates.
 */
export async function stockEarnings(symbol: string): Promise<string> {
  const data = await avFetch({ function: "EARNINGS", symbol: symbol.toUpperCase() });

  if (!data.quarterlyEarnings) return `No earnings data for ${symbol.toUpperCase()}.`;

  const quarters = (data.quarterlyEarnings as QuarterlyEarning[]).slice(0, 4);
  const lines = quarters.map((q) => {
    const surprise = Number(q.surprisePercentage);
    const emoji = isNaN(surprise) ? "" : surprise >= 0 ? " ✓" : " ✗";
    return `  ${q.fiscalDateEnding}: EPS ${q.reportedEPS} vs est ${q.estimatedEPS} | Surprise: ${q.surprisePercentage !== "None" ? `${Number(q.surprisePercentage).toFixed(1)}%` : "N/A"}${emoji}`;
  });

  return `**${symbol.toUpperCase()} — Last 4 quarters (EPS):**\n${lines.join("\n")}`;
}

interface AnnualIncome {
  fiscalDateEnding: string;
  totalRevenue: string;
  grossProfit: string;
  operatingIncome: string;
  netIncome: string;
}

/**
 * Last 2 annual income statements.
 */
export async function stockIncomeStatement(symbol: string): Promise<string> {
  const data = await avFetch({ function: "INCOME_STATEMENT", symbol: symbol.toUpperCase() });

  if (!data.annualReports) return `No income data for ${symbol.toUpperCase()}.`;

  const reports = (data.annualReports as AnnualIncome[]).slice(0, 2);
  const lines = reports.map((r) => {
    const rev = Number(r.totalRevenue);
    const gross = Number(r.grossProfit);
    const margin = !isNaN(rev) && !isNaN(gross) && rev > 0
      ? ` (${(gross / rev * 100).toFixed(1)}% gross margin)`
      : "";
    return [
      `  **FY ${r.fiscalDateEnding.slice(0, 4)}:**`,
      `    Revenue: ${fmtNum(r.totalRevenue, "$")} | Gross profit: ${fmtNum(r.grossProfit, "$")}${margin}`,
      `    Operating income: ${fmtNum(r.operatingIncome, "$")} | Net income: ${fmtNum(r.netIncome, "$")}`,
    ].join("\n");
  });

  return `**${symbol.toUpperCase()} — Annual Income Statement:**\n${lines.join("\n\n")}`;
}

/**
 * Valuation multiples from Alpha Vantage OVERVIEW.
 */
export async function stockValuation(symbol: string): Promise<string> {
  const data = await avFetch({ function: "OVERVIEW", symbol: symbol.toUpperCase() });

  if (!data.Symbol) return `No data found for ${symbol.toUpperCase()}.`;

  return [
    `**${data.Symbol} — Valuation Multiples:**`,
    `P/E: ${data.PERatio ?? "N/A"} | Forward P/E: ${data.ForwardPE ?? "N/A"} | PEG: ${data.PEGRatio ?? "N/A"}`,
    `Price/Book: ${data.PriceToBookRatio ?? "N/A"} | Price/Sales: ${data.PriceToSalesRatioTTM ?? "N/A"}`,
    `EV/Revenue: ${data.EVToRevenue ?? "N/A"} | EV/EBITDA: ${data.EVToEBITDA ?? "N/A"}`,
    `Book value/share: $${data.BookValue ?? "N/A"} | Revenue/share TTM: $${data.RevenuePerShareTTM ?? "N/A"}`,
    `Profit margin: ${data.ProfitMargin != null && data.ProfitMargin !== "None" ? `${(Number(data.ProfitMargin) * 100).toFixed(2)}%` : "N/A"}`,
    `ROE: ${data.ReturnOnEquityTTM != null && data.ReturnOnEquityTTM !== "None" ? `${(Number(data.ReturnOnEquityTTM) * 100).toFixed(2)}%` : "N/A"} | ROA: ${data.ReturnOnAssetsTTM != null && data.ReturnOnAssetsTTM !== "None" ? `${(Number(data.ReturnOnAssetsTTM) * 100).toFixed(2)}%` : "N/A"}`,
  ].join("\n");
}
