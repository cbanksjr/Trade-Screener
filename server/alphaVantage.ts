import { config } from "./config";

export type AlphaVantageOverview = {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  beta?: number;
  eps?: number;
  peRatio?: number;
  dividendAmount?: number;
  dividendYield?: number;
  explicitZeroDividend?: boolean;
  dividendExDate?: string;
  dividendPayDate?: string;
};

export type AlphaVantageResult = {
  overview?: AlphaVantageOverview;
  warning?: string;
};

export type AlphaVantageEarningsCalendarResult = {
  nextEarningsDate?: string;
  warning?: string;
};

export async function fetchAlphaVantageOverview(symbol: string): Promise<AlphaVantageResult> {
  if (!config.alphaVantageApiKey) {
    return { warning: "Alpha Vantage API key is missing." };
  }

  try {
    const url = new URL(config.alphaVantageBaseUrl);
    url.searchParams.set("function", "OVERVIEW");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", config.alphaVantageApiKey);
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return { warning: `Alpha Vantage request failed: ${response.status} ${response.statusText}` };
    }
    return normalizeAlphaVantageResponse(await response.json() as Record<string, unknown>);
  } catch (error) {
    return { warning: error instanceof Error ? error.message : "Alpha Vantage fundamentals request failed." };
  }
}

export async function fetchAlphaVantageEarningsCalendar(symbol: string): Promise<AlphaVantageEarningsCalendarResult> {
  if (!config.alphaVantageApiKey) {
    return { warning: "Alpha Vantage API key is missing." };
  }

  try {
    const url = new URL(config.alphaVantageBaseUrl);
    url.searchParams.set("function", "EARNINGS_CALENDAR");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("horizon", "3month");
    url.searchParams.set("apikey", config.alphaVantageApiKey);
    const response = await fetch(url);
    if (!response.ok) {
      return { warning: `Alpha Vantage earnings calendar request failed: ${response.status} ${response.statusText}` };
    }
    return normalizeAlphaVantageEarningsCalendar(await response.text(), symbol);
  } catch (error) {
    return { warning: error instanceof Error ? error.message : "Alpha Vantage earnings calendar request failed." };
  }
}

export function normalizeAlphaVantageResponse(payload: Record<string, unknown>): AlphaVantageResult {
  const providerMessage = stringValue(payload.Note, payload.Information, payload["Error Message"]);
  if (providerMessage) return { warning: `Alpha Vantage: ${providerMessage}` };

  const overview = normalizeAlphaVantageOverview(payload);
  if (!overview) return { warning: "Alpha Vantage did not return company overview data." };
  return { overview };
}

export function normalizeAlphaVantageOverview(payload: Record<string, unknown>): AlphaVantageOverview | undefined {
  const symbol = stringValue(payload.Symbol)?.toUpperCase();
  if (!symbol) return undefined;

  return {
    symbol,
    companyName: stringValue(payload.Name),
    marketCap: firstPositiveNumber(payload.MarketCapitalization),
    beta: firstPositiveNumber(payload.Beta),
    eps: firstNumber(payload.EPS),
    peRatio: firstPositiveNumber(payload.PERatio),
    dividendAmount: firstNonNegativeNumber(payload.DividendPerShare),
    dividendYield: normalizeDividendYield(payload.DividendYield),
    explicitZeroDividend: isExplicitZero(payload.DividendPerShare) && isExplicitZero(payload.DividendYield),
    dividendExDate: dateStringValue(payload.ExDividendDate),
    dividendPayDate: dateStringValue(payload.DividendDate)
  };
}

export function normalizeAlphaVantageEarningsCalendar(csv: string, symbol: string): AlphaVantageEarningsCalendarResult {
  const trimmed = csv.trim();
  if (!trimmed) return { warning: "Alpha Vantage did not return earnings calendar data." };
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const providerMessage = stringValue(payload.Note, payload.Information, payload["Error Message"]);
      if (providerMessage) return { warning: `Alpha Vantage: ${providerMessage}` };
    } catch {
      return { warning: "Alpha Vantage earnings calendar response could not be parsed." };
    }
  }

  const rows = trimmed.split(/\r?\n/).filter(Boolean);
  const header = rows.shift()?.split(",").map((item) => item.trim()) ?? [];
  const symbolIndex = header.indexOf("symbol");
  const reportDateIndex = header.indexOf("reportDate");
  if (symbolIndex < 0 || reportDateIndex < 0) return { warning: "Alpha Vantage earnings calendar response was missing expected columns." };

  const requested = symbol.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const dates = rows
    .map((row) => splitCsvRow(row))
    .filter((columns) => columns[symbolIndex]?.toUpperCase() === requested)
    .map((columns) => dateStringValue(columns[reportDateIndex]))
    .filter((value): value is string => typeof value === "string" && value >= today)
    .sort();

  return dates[0] ? { nextEarningsDate: dates[0] } : { warning: "Alpha Vantage did not return a future earnings date for " + requested + "." };
}

function splitCsvRow(row: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of row) {
    if (character === "\"") {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      output.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  output.push(current.trim());
  return output;
}

function normalizeDividendYield(value: unknown): number | undefined {
  const parsed = firstNonNegativeNumber(value);
  if (parsed === undefined) return undefined;
  return Number((parsed <= 1 ? parsed * 100 : parsed).toFixed(4));
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed !== 0) return parsed;
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function isExplicitZero(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value !== "string") return false;
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed === 0;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value && value !== "None") return value;
  }
  return undefined;
}

function dateStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  return undefined;
}
