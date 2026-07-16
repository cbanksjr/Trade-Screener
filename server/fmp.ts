import { config } from "./config";
import { fetchWithRetry } from "./httpRetry";
import { getSetting, setSetting } from "./memoryStore";

export type FmpFundamentals = {
  symbol: string;
  companyName?: string;
  beta?: number;
  marketCap?: number;
  averageVolume?: number;
  sector?: string;
  nextEarningsDate?: string;
};

export type FmpNeededFields = {
  beta?: boolean;
  marketCap?: boolean;
  averageVolume?: boolean;
  sector?: boolean;
  nextEarningsDate?: boolean;
};

export type FmpCacheEntry = {
  updatedAt: string;
  data: FmpFundamentals;
};

export type FmpCache = Record<string, FmpCacheEntry>;

export type FmpEnrichment = {
  data?: FmpFundamentals;
  warnings: string[];
  usedLive: boolean;
};

export type FmpCalendarResult = {
  earningsBySymbol: Map<string, string>;
  warnings: string[];
  usedLive: boolean;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CACHE_KEY = "fmpFundamentalsCache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FMP_SECTOR_TO_GICS: Record<string, string> = {
  "basic materials": "Materials",
  "consumer cyclical": "Consumer Discretionary",
  "consumer defensive": "Consumer Staples",
  "financial services": "Financials",
  healthcare: "Health Care",
  technology: "Information Technology"
};

export async function createFmpScanFallback(): Promise<ReturnType<typeof createFmpFallback>> {
  const cache = await getSetting<FmpCache>(CACHE_KEY, {});
  const fallback = createFmpFallback({
    apiKey: config.fmpApiKey,
    baseUrl: config.fmpBaseUrl,
    maxCalls: Math.max(0, config.fmpMaxCallsPerScan),
    cache
  });
  return {
    ...fallback,
    async flush() {
      if (fallback.isDirty()) await setSetting(CACHE_KEY, fallback.cache());
    }
  };
}

export function createFmpFallback(input: {
  apiKey: string;
  baseUrl: string;
  maxCalls: number;
  cache?: FmpCache;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  let remainingCalls = input.maxCalls;
  let dirty = false;
  const cache: FmpCache = { ...(input.cache ?? {}) };
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  async function enrich(symbol: string, needed: FmpNeededFields): Promise<FmpEnrichment> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !needsAnyField(needed)) return { warnings: [], usedLive: false };

    const cached = cache[upperSymbol];
    const freshCachedData = cached && isFresh(cached.updatedAt, now()) ? cached.data : undefined;
    if (freshCachedData && hasNeededFields(freshCachedData, needed)) {
      return { data: filterNeeded(freshCachedData, needed), warnings: [], usedLive: false };
    }

    if (!input.apiKey) return { warnings: [], usedLive: false };

    const output: FmpFundamentals = { ...(freshCachedData ?? { symbol: upperSymbol }), symbol: upperSymbol };
    const warnings: string[] = [];
    let usedLive = false;

    if (needsProfile(needed) && !hasNeededProfileFields(output, needed)) {
      const call = await callWithBudget(() => fetchProfile(upperSymbol, input, fetchImpl));
      if (call.warning) warnings.push(call.warning);
      if (call.data) {
        Object.assign(output, call.data);
        usedLive = true;
      }
    }

    if (needed.nextEarningsDate && !output.nextEarningsDate) {
      const call = await callWithBudget(() => fetchNextEarningsDate(upperSymbol, input, fetchImpl, now()));
      if (call.warning) warnings.push(call.warning);
      if (call.data) {
        output.nextEarningsDate = call.data.nextEarningsDate;
        usedLive = true;
      } else if (!call.warning) {
        warnings.push("Next earnings date unavailable from FMP.");
      }
    }

    if (hasFundamentalData(output)) {
      if (usedLive || !cached) {
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
      return { data: filterNeeded(output, needed), warnings, usedLive };
    }

    if (!warnings.length && needsAnyField(needed) && remainingCalls <= 0) {
      warnings.push("FMP fallback call budget exhausted.");
    }
    return { warnings, usedLive };
  }

  async function earningsCalendar(symbols: string[]): Promise<FmpCalendarResult> {
    const wanted = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
    if (!wanted.size || !input.apiKey) return { earningsBySymbol: new Map(), warnings: [], usedLive: false };

    const call = await callWithBudget(() => fetchEarningsCalendar(input, fetchImpl, now()));
    if (call.warning) return { earningsBySymbol: new Map(), warnings: [call.warning], usedLive: false };

    const earningsBySymbol = normalizeFmpEarningsCalendar(call.data, wanted, now());
    const timestamp = now().toISOString();
    for (const [symbol, nextEarningsDate] of earningsBySymbol) {
      const cached = cache[symbol]?.data ?? { symbol };
      cache[symbol] = {
        updatedAt: timestamp,
        data: {
          ...cached,
          symbol,
          nextEarningsDate
        }
      };
    }
    if (earningsBySymbol.size) dirty = true;
    return { earningsBySymbol, warnings: [], usedLive: true };
  }

  async function callWithBudget<T>(loader: () => Promise<T>): Promise<{ data?: T; warning?: string }> {
    if (remainingCalls <= 0) return { warning: "FMP fallback call budget exhausted." };
    remainingCalls -= 1;
    try {
      return { data: await loader() };
    } catch (error) {
      return { warning: error instanceof Error ? error.message : "FMP fallback request failed." };
    }
  }

  async function verifyNextEarningsDate(symbol: string, candidateDate?: string): Promise<FmpEnrichment> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !input.apiKey) return { warnings: [], usedLive: false };

    const call = await callWithBudget(() => fetchNextEarningsDate(upperSymbol, input, fetchImpl, now()));
    if (call.warning) return { warnings: [call.warning], usedLive: false };

    if (!call.data?.nextEarningsDate) {
      return {
        data: candidateDate ? { symbol: upperSymbol, nextEarningsDate: candidateDate } : undefined,
        warnings: ["Exact-symbol next earnings date unavailable from FMP."],
        usedLive: true
      };
    }

    const nextEarningsDate = earliestFutureDate([candidateDate, call.data.nextEarningsDate], now());
    if (!nextEarningsDate) return { warnings: ["Next earnings date unavailable from FMP."], usedLive: true };

    cache[upperSymbol] = {
      updatedAt: now().toISOString(),
      data: {
        ...(cache[upperSymbol]?.data ?? { symbol: upperSymbol }),
        symbol: upperSymbol,
        nextEarningsDate
      }
    };
    dirty = true;
    return { data: { symbol: upperSymbol, nextEarningsDate }, warnings: [], usedLive: true };
  }

  return {
    enrich,
    verifyNextEarningsDate,
    earningsCalendar,
    cache: () => cache,
    isDirty: () => dirty,
    remainingCalls: () => remainingCalls,
    async flush() {
      // Overridden by createFmpScanFallback where persistent settings are available.
    }
  };
}

export function normalizeFmpProfile(payload: unknown): FmpFundamentals | undefined {
  const warning = fmpPayloadWarning(payload);
  if (warning) throw new Error(warning);

  const item = firstObject(payload);
  if (!item) return undefined;
  const symbol = stringValue(item.symbol, item.Symbol)?.toUpperCase();
  if (!symbol) return undefined;
  const data: FmpFundamentals = {
    symbol,
    companyName: stringValue(item.companyName, item.company, item.name, item.Name),
    beta: numberValue(item.beta, item.Beta),
    marketCap: numberValue(item.mktCap, item.marketCap, item.marketCapitalization, item.MarketCapitalization),
    averageVolume: numberValue(item.averageVolume, item.avgVolume, item.avg10DaysVolume, item.avg1YearVolume),
    sector: stringValue(item.sector, item.Sector)
  };
  data.sector = normalizeFmpSector(data.sector);
  return hasFundamentalData(data) ? data : undefined;
}

export function normalizeFmpSector(sector?: string): string | undefined {
  const value = stringValue(sector);
  if (!value) return undefined;
  return FMP_SECTOR_TO_GICS[value.toLowerCase()] ?? value;
}

export function normalizeFmpEarnings(payload: unknown, symbol: string, now = new Date()): string | undefined {
  const warning = fmpPayloadWarning(payload);
  if (warning) throw new Error(warning);
  if (!Array.isArray(payload)) return undefined;

  const upperSymbol = symbol.toUpperCase();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return payload
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => {
      const rowSymbol = stringValue(item.symbol, item.Symbol)?.toUpperCase();
      return rowSymbol === upperSymbol;
    })
    .map((item) => stringValue(item.date, item.reportDate, item.reportedDate))
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    .filter((value) => new Date(value + "T00:00:00.000Z").getTime() >= today.getTime())
    .sort()[0];
}

export function normalizeFmpEarningsCalendar(payload: unknown, symbols: Iterable<string>, now = new Date()): Map<string, string> {
  const warning = fmpPayloadWarning(payload);
  if (warning) throw new Error(warning);
  const wanted = new Set([...symbols].map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
  const output = new Map<string, string>();
  if (!Array.isArray(payload) || !wanted.size) return output;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const rows = payload
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      symbol: stringValue(item.symbol, item.Symbol)?.toUpperCase(),
      date: stringValue(item.date, item.reportDate, item.reportedDate)
    }))
    .filter((item): item is { symbol: string; date: string } => typeof item.symbol === "string" && wanted.has(item.symbol) && typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .filter((item) => new Date(item.date + "T00:00:00.000Z").getTime() >= today.getTime())
    .sort((left, right) => left.date.localeCompare(right.date));

  for (const item of rows) {
    if (!output.has(item.symbol)) output.set(item.symbol, item.date);
  }
  return output;
}

async function fetchProfile(symbol: string, input: { apiKey: string; baseUrl: string }, fetchImpl: FetchLike): Promise<FmpFundamentals | undefined> {
  const data = await fmpJson(input.baseUrl, "profile", { symbol, apikey: input.apiKey }, fetchImpl);
  return normalizeFmpProfile(data);
}

async function fetchNextEarningsDate(symbol: string, input: { apiKey: string; baseUrl: string }, fetchImpl: FetchLike, now: Date): Promise<FmpFundamentals | undefined> {
  const data = await fmpJson(input.baseUrl, "earnings", {
    symbol,
    apikey: input.apiKey
  }, fetchImpl);
  const nextEarningsDate = normalizeFmpEarnings(data, symbol, now);
  return nextEarningsDate ? { symbol, nextEarningsDate } : undefined;
}

async function fetchEarningsCalendar(input: { apiKey: string; baseUrl: string }, fetchImpl: FetchLike, now: Date): Promise<unknown> {
  return fmpJson(input.baseUrl, "earnings-calendar", {
    from: toDateString(now),
    to: toDateString(new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000)),
    apikey: input.apiKey
  }, fetchImpl);
}

async function fmpJson(baseUrl: string, path: string, params: Record<string, string>, fetchImpl: FetchLike): Promise<unknown> {
  const url = fmpUrl(baseUrl, path, params);
  const response = await fetchWithRetry((signal) => fetchImpl(url, { signal }));
  const text = await response.text();
  if (response.status === 429) throw new Error(`FMP ${path} request was rate limited.`);
  if (!response.ok) throw new Error(`FMP request failed: ${response.status} ${response.statusText}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("FMP returned a malformed JSON payload.");
  }
}

function fmpUrl(baseUrl: string, path: string, params: Record<string, string>): URL {
  const root = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = new URL(path.replace(/^\/+/, ""), root);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function needsProfile(needed: FmpNeededFields): boolean {
  return Boolean(needed.beta || needed.marketCap || needed.averageVolume || needed.sector);
}

function needsAnyField(needed: FmpNeededFields): boolean {
  return Boolean(needsProfile(needed) || needed.nextEarningsDate);
}

function earliestFutureDate(values: Array<string | undefined>, now: Date): string | undefined {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return values
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    .filter((value) => new Date(value + "T00:00:00.000Z").getTime() >= today.getTime())
    .sort()[0];
}

function hasNeededFields(data: FmpFundamentals, needed: FmpNeededFields): boolean {
  return hasNeededProfileFields(data, needed) && (!needed.nextEarningsDate || Boolean(data.nextEarningsDate));
}

function hasNeededProfileFields(data: FmpFundamentals, needed: FmpNeededFields): boolean {
  return (!needed.beta || data.beta !== undefined)
    && (!needed.marketCap || data.marketCap !== undefined)
    && (!needed.averageVolume || data.averageVolume !== undefined)
    && (!needed.sector || Boolean(data.sector));
}

function filterNeeded(data: FmpFundamentals, needed: FmpNeededFields): FmpFundamentals | undefined {
  const output: FmpFundamentals = { symbol: data.symbol };
  if (needed.beta) output.beta = data.beta;
  if (needed.marketCap) output.marketCap = data.marketCap;
  if (needed.averageVolume) output.averageVolume = data.averageVolume;
  if (needed.sector) output.sector = data.sector;
  if (needed.nextEarningsDate) output.nextEarningsDate = data.nextEarningsDate;
  if (needed.sector) output.companyName = data.companyName;
  return hasFundamentalData(output) ? output : undefined;
}

function isFresh(updatedAt: string, now: Date): boolean {
  const timestamp = new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now.getTime() - timestamp < CACHE_TTL_MS;
}

function hasFundamentalData(data: FmpFundamentals): boolean {
  return data.beta !== undefined
    || data.marketCap !== undefined
    || data.averageVolume !== undefined
    || Boolean(data.sector)
    || Boolean(data.nextEarningsDate)
    || Boolean(data.companyName);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fmpPayloadWarning(payload: unknown): string | undefined {
  const item = firstObject(payload);
  return item ? stringValue(item.Note, item.Information, item["Error Message"], item.error, item.message) : undefined;
}

function firstObject(payload: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(payload)) return payload.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "string" && ["", "none", "null", "-"].includes(value.trim().toLowerCase())) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
