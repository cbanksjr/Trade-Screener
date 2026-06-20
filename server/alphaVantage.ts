import { config } from "./config";
import { getSetting, setSetting } from "./sqlite";

export type AlphaVantageFundamentals = {
  symbol: string;
  companyName?: string;
  beta?: number;
  marketCap?: number;
  sector?: string;
  lastEarningsDate?: string;
};

export type AlphaVantageNeededFields = {
  beta?: boolean;
  marketCap?: boolean;
  sector?: boolean;
  lastEarningsDate?: boolean;
};

export type AlphaVantageCacheEntry = {
  updatedAt: string;
  data: AlphaVantageFundamentals;
};

export type AlphaVantageCache = Record<string, AlphaVantageCacheEntry>;

export type AlphaVantageEnrichment = {
  data?: AlphaVantageFundamentals;
  warnings: string[];
  usedLive: boolean;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CACHE_KEY = "alphaVantageFundamentalsCache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function createAlphaVantageScanFallback(): Promise<ReturnType<typeof createAlphaVantageFallback>> {
  const cache = await getSetting<AlphaVantageCache>(CACHE_KEY, {});
  const fallback = createAlphaVantageFallback({
    apiKey: config.alphaVantageApiKey,
    baseUrl: config.alphaVantageBaseUrl,
    maxCalls: Math.max(0, config.alphaVantageMaxCallsPerScan),
    cache
  });
  return {
    ...fallback,
    async flush() {
      if (fallback.isDirty()) await setSetting(CACHE_KEY, fallback.cache());
    }
  };
}

export function createAlphaVantageFallback(input: {
  apiKey: string;
  baseUrl: string;
  maxCalls: number;
  cache?: AlphaVantageCache;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  let remainingCalls = input.maxCalls;
  let dirty = false;
  const cache: AlphaVantageCache = { ...(input.cache ?? {}) };
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  async function enrich(symbol: string, needed: AlphaVantageNeededFields): Promise<AlphaVantageEnrichment> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !needsAnyField(needed)) return { warnings: [], usedLive: false };

    const cached = cache[upperSymbol];
    if (cached && isFresh(cached.updatedAt, now())) {
      return { data: filterNeeded(cached.data, needed), warnings: [], usedLive: false };
    }

    if (!input.apiKey) return { warnings: [], usedLive: false };

    const output: AlphaVantageFundamentals = { symbol: upperSymbol };
    const warnings: string[] = [];
    let usedLive = false;

    if (needsOverview(needed)) {
      const call = await callWithBudget(() => fetchOverview(upperSymbol, input, fetchImpl));
      if (call.warning) warnings.push(call.warning);
      if (call.data) {
        Object.assign(output, call.data);
        usedLive = true;
      }
    }

    if (needed.lastEarningsDate) {
      const call = await callWithBudget(() => fetchNextEarningsDate(upperSymbol, input, fetchImpl, now()));
      if (call.warning) warnings.push(call.warning);
      if (call.data) {
        output.lastEarningsDate = call.data.lastEarningsDate;
        usedLive = true;
      }
    }

    if (hasFundamentalData(output)) {
      cache[upperSymbol] = {
        updatedAt: now().toISOString(),
        data: {
          ...(cached?.data ?? { symbol: upperSymbol }),
          ...output,
          symbol: upperSymbol
        }
      };
      dirty = true;
      return { data: filterNeeded(cache[upperSymbol].data, needed), warnings, usedLive };
    }

    if (!warnings.length && needsAnyField(needed) && remainingCalls <= 0) {
      warnings.push("AlphaVantage fallback call budget exhausted.");
    }
    return { warnings, usedLive };
  }

  async function callWithBudget<T>(loader: () => Promise<T>): Promise<{ data?: T; warning?: string }> {
    if (remainingCalls <= 0) return { warning: "AlphaVantage fallback call budget exhausted." };
    remainingCalls -= 1;
    try {
      return { data: await loader() };
    } catch (error) {
      return { warning: error instanceof Error ? error.message : "AlphaVantage fallback request failed." };
    }
  }

  return {
    enrich,
    cache: () => cache,
    isDirty: () => dirty,
    remainingCalls: () => remainingCalls,
    async flush() {
      // Overridden by createAlphaVantageScanFallback where persistent settings are available.
    }
  };
}

export function normalizeAlphaVantageOverview(payload: Record<string, unknown>): AlphaVantageFundamentals | undefined {
  const warning = alphaVantagePayloadWarning(payload);
  if (warning) throw new Error(warning);

  const symbol = stringValue(payload.Symbol)?.toUpperCase();
  if (!symbol) return undefined;
  const data: AlphaVantageFundamentals = {
    symbol,
    companyName: stringValue(payload.Name),
    beta: numberValue(payload.Beta),
    marketCap: numberValue(payload.MarketCapitalization),
    sector: stringValue(payload.Sector)
  };
  return hasFundamentalData(data) ? data : undefined;
}

export function parseAlphaVantageEarningsCalendar(csv: string, symbol: string, now = new Date()): string | undefined {
  const warning = alphaVantageTextWarning(csv);
  if (warning) throw new Error(warning);

  const rows = parseCsv(csv);
  const [headers, ...records] = rows;
  if (!headers?.length) return undefined;
  const symbolIndex = headers.findIndex((header) => header.toLowerCase() === "symbol");
  const reportDateIndex = headers.findIndex((header) => header.toLowerCase() === "reportdate");
  if (symbolIndex < 0 || reportDateIndex < 0) return undefined;

  const upperSymbol = symbol.toUpperCase();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return records
    .filter((row) => row[symbolIndex]?.toUpperCase() === upperSymbol)
    .map((row) => row[reportDateIndex])
    .filter((value): value is string => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .filter((value) => new Date(value + "T00:00:00.000Z").getTime() >= today.getTime())
    .sort()[0];
}

async function fetchOverview(symbol: string, input: { apiKey: string; baseUrl: string }, fetchImpl: FetchLike): Promise<AlphaVantageFundamentals | undefined> {
  const data = await alphaVantageJson(input.baseUrl, {
    function: "OVERVIEW",
    symbol,
    apikey: input.apiKey
  }, fetchImpl);
  return normalizeAlphaVantageOverview(data);
}

async function fetchNextEarningsDate(symbol: string, input: { apiKey: string; baseUrl: string }, fetchImpl: FetchLike, now: Date): Promise<AlphaVantageFundamentals | undefined> {
  const text = await alphaVantageText(input.baseUrl, {
    function: "EARNINGS_CALENDAR",
    symbol,
    horizon: "3month",
    apikey: input.apiKey
  }, fetchImpl);
  const lastEarningsDate = parseAlphaVantageEarningsCalendar(text, symbol, now);
  return lastEarningsDate ? { symbol, lastEarningsDate } : undefined;
}

async function alphaVantageJson(baseUrl: string, params: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const text = await alphaVantageText(baseUrl, params, fetchImpl);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AlphaVantage returned a malformed JSON payload.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("AlphaVantage returned a malformed JSON payload.");
    throw error;
  }
}

async function alphaVantageText(baseUrl: string, params: Record<string, string>, fetchImpl: FetchLike): Promise<string> {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetchImpl(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`AlphaVantage request failed: ${response.status} ${response.statusText}`);
  return text;
}

function needsOverview(needed: AlphaVantageNeededFields): boolean {
  return Boolean(needed.beta || needed.marketCap || needed.sector);
}

function needsAnyField(needed: AlphaVantageNeededFields): boolean {
  return Boolean(needsOverview(needed) || needed.lastEarningsDate);
}

function filterNeeded(data: AlphaVantageFundamentals, needed: AlphaVantageNeededFields): AlphaVantageFundamentals | undefined {
  const output: AlphaVantageFundamentals = { symbol: data.symbol };
  if (needed.beta) output.beta = data.beta;
  if (needed.marketCap) output.marketCap = data.marketCap;
  if (needed.sector) output.sector = data.sector;
  if (needed.lastEarningsDate) output.lastEarningsDate = data.lastEarningsDate;
  if (needed.sector) output.companyName = data.companyName;
  return hasFundamentalData(output) ? output : undefined;
}

function isFresh(updatedAt: string, now: Date): boolean {
  const timestamp = new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now.getTime() - timestamp < CACHE_TTL_MS;
}

function hasFundamentalData(data: AlphaVantageFundamentals): boolean {
  return data.beta !== undefined
    || data.marketCap !== undefined
    || Boolean(data.sector)
    || Boolean(data.lastEarningsDate)
    || Boolean(data.companyName);
}

function alphaVantagePayloadWarning(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.Note, payload.Information, payload["Error Message"]);
}

function alphaVantageTextWarning(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return alphaVantagePayloadWarning(parsed as Record<string, unknown>);
  } catch {
    return undefined;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && ["", "none", "null", "-"].includes(value.trim().toLowerCase())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || ["none", "null", "-"].includes(trimmed.toLowerCase())) continue;
    return trimmed;
  }
  return undefined;
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
