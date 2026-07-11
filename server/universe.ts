import { defaultUniverseName, defaultUniverseSymbols } from "./defaultUniverse";
import { config } from "./config";
import { normalizeFmpSector } from "./fmp";
import { getSetting, setSetting } from "./sqlite";

export type UniverseCache = {
  symbols: string[];
  updatedAt: string;
  source: string;
  added: string[];
  removed: string[];
  sectorBySymbol?: Record<string, string>;
};

const UNIVERSE_SETTING = "defaultUniverseCache";
export const MIN_REFRESHED_SYMBOLS = 450;
const FMP_UNIVERSE_SOURCE = "FMP S&P 500 + Nasdaq constituent endpoints";
const PUBLIC_UNIVERSE_SOURCE = "public S&P 500 + Nasdaq 100 pages";
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function getDefaultUniverseName(): string {
  return defaultUniverseName;
}

export async function getDefaultUniverseSymbols(): Promise<string[]> {
  return resolveDefaultUniverseSymbols(await getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined));
}

export async function getDefaultUniverseSectorMap(): Promise<Record<string, string>> {
  const cached = await getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined);
  return cached?.sectorBySymbol ?? {};
}

export function resolveDefaultUniverseSymbols(cached?: UniverseCache): string[] {
  if (cached && cached.symbols.length >= MIN_REFRESHED_SYMBOLS) return cached.symbols;
  return defaultUniverseSymbols;
}

export async function hasCachedDefaultUniverse(): Promise<boolean> {
  const cached = await getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined);
  return resolveDefaultUniverseSymbols(cached) === cached?.symbols;
}

export async function getDefaultUniverseStatus() {
  const cached = await getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined);
  return {
    name: defaultUniverseName,
    count: (await getDefaultUniverseSymbols()).length,
    bundledCount: defaultUniverseSymbols.length,
    lastCheckedAt: cached?.updatedAt,
    source: cached?.source ?? "bundled",
    added: cached?.added ?? [],
    removed: cached?.removed ?? []
  };
}

export async function refreshDefaultUniverse(): Promise<UniverseCache> {
  const next = await loadRefreshedUniverse(fetch);
  const previous = await getDefaultUniverseSymbols();
  const cache: UniverseCache = {
    ...next,
    updatedAt: new Date().toISOString(),
    added: next.symbols.filter((symbol) => !previous.includes(symbol)),
    removed: previous.filter((symbol) => !next.symbols.includes(symbol))
  };
  await setSetting(UNIVERSE_SETTING, cache);
  return cache;
}

export async function loadRefreshedUniverse(fetchImpl: FetchLike = fetch, useFmp = Boolean(config.fmpApiKey)): Promise<Omit<UniverseCache, "updatedAt" | "added" | "removed">> {
  if (useFmp) {
    try {
      return assertCompleteUniverse(await loadFmpUniverse(fetchImpl));
    } catch {
      // Fall back to public sources when FMP is unavailable, rate-limited, malformed, or incomplete.
    }
  }
  return assertCompleteUniverse(await loadPublicUniverse(fetchImpl));
}

export function buildFmpUniverse(sp500Payload: unknown, nasdaqPayload: unknown): Omit<UniverseCache, "updatedAt" | "added" | "removed"> {
  const sp500 = parseFmpConstituents(sp500Payload);
  const nasdaq = parseFmpConstituents(nasdaqPayload);
  return {
    symbols: normalizeSymbols([...sp500.symbols, ...nasdaq.symbols]),
    source: FMP_UNIVERSE_SOURCE,
    sectorBySymbol: { ...sp500.sectorBySymbol, ...nasdaq.sectorBySymbol }
  };
}

export function parseFmpConstituents(payload: unknown): { symbols: string[]; sectorBySymbol: Record<string, string> } {
  if (!Array.isArray(payload)) throw new Error("FMP constituent response was not an array.");
  const symbols: string[] = [];
  const sectorBySymbol: Record<string, string> = {};
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const symbol = stringValue(row.symbol, row.Symbol)?.toUpperCase();
    if (!symbol || !isTradableSymbol(symbol)) continue;
    symbols.push(symbol);
    const sector = normalizeFmpSector(stringValue(row.sector, row.Sector));
    if (sector) sectorBySymbol[symbol] = sector;
  }
  return { symbols: normalizeSymbols(symbols), sectorBySymbol };
}

export function parseSp500Symbols(html: string): string[] {
  return parseSp500Constituents(html).symbols;
}

export function parseSp500Constituents(html: string): { symbols: string[]; sectorBySymbol: Record<string, string> } {
  const table = html.match(/<table[^>]+id="constituents"[\s\S]*?<\/table>/i)?.[0] ?? html;
  const sectorBySymbol: Record<string, string> = {};
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const symbols: string[] = [];
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripTags(cell[1]));
    const symbol = cells[0]?.trim().toUpperCase();
    const sector = cells[2]?.trim();
    if (symbol && isTradableSymbol(symbol)) {
      symbols.push(symbol);
      if (sector) sectorBySymbol[symbol] = sector;
    }
  }
  if (!symbols.length) {
    symbols.push(...[...table.matchAll(/<td>\s*<a[^>]*>\s*([A-Z][A-Z.]{0,5})\s*<\/a>\s*<\/td>/g)].map((match) => match[1]));
  }
  return { symbols: normalizeSymbols(symbols), sectorBySymbol };
}

export function parseNasdaq100Symbols(html: string): string[] {
  const symbols = [
    ...[...html.matchAll(/\/stocks\/([a-z0-9.-]+)\/["'][^>]*>\s*([A-Z][A-Z.]{0,5})\s*</gi)].map((match) => match[2]),
    ...[...html.matchAll(/<td[^>]*>\s*([A-Z][A-Z.]{0,5})\s*<\/td>/g)].map((match) => match[1])
  ];
  return normalizeSymbols(symbols);
}

function buildPublicUniverse(sp500Html: string, nasdaqHtml: string): Omit<UniverseCache, "updatedAt" | "added" | "removed"> {
  const sp500 = parseSp500Constituents(sp500Html);
  return {
    symbols: normalizeSymbols([
      ...sp500.symbols,
      ...parseNasdaq100Symbols(nasdaqHtml)
    ]),
    source: PUBLIC_UNIVERSE_SOURCE,
    sectorBySymbol: sp500.sectorBySymbol
  };
}

async function loadFmpUniverse(fetchImpl: FetchLike): Promise<Omit<UniverseCache, "updatedAt" | "added" | "removed">> {
  const [sp500, nasdaq] = await Promise.all([
    fetchJson(fmpUrl("sp500-constituent"), fetchImpl),
    fetchJson(fmpUrl("nasdaq-constituent"), fetchImpl)
  ]);
  return buildFmpUniverse(sp500, nasdaq);
}

async function loadPublicUniverse(fetchImpl: FetchLike): Promise<Omit<UniverseCache, "updatedAt" | "added" | "removed">> {
  const [sp500Html, nasdaqHtml] = await Promise.all([
    fetchText("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", fetchImpl),
    fetchText("https://stockanalysis.com/list/nasdaq-100-stocks/", fetchImpl)
  ]);
  return buildPublicUniverse(sp500Html, nasdaqHtml);
}

function assertCompleteUniverse<T extends { symbols: string[] }>(universe: T): T {
  if (universe.symbols.length < MIN_REFRESHED_SYMBOLS) {
    throw new Error(`Default universe refresh returned only ${universe.symbols.length} symbols.`);
  }
  return universe;
}

// The monthly refresh cron in index.ts fires in America/Chicago, so the
// last-day check must use the same timezone regardless of server locale.
export function isLastDayOfMonth(date = new Date(), timeZone = "America/Chicago"): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const daysInMonth = new Date(read("year"), read("month"), 0).getDate();
  return read("day") === daysInMonth;
}

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(isTradableSymbol))].sort();
}

function isTradableSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z.]{0,5}$/.test(symbol);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "Trade-Screener/1.0"
    }
  });
  if (!response.ok) throw new Error(`Universe source request failed: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url: URL, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "Trade-Screener/1.0"
    }
  });
  if (response.status === 429) throw new Error("FMP universe request was rate limited.");
  if (!response.ok) throw new Error(`FMP universe request failed: ${response.status} ${response.statusText}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error("FMP universe response was malformed JSON.");
  }
}

function fmpUrl(path: string): URL {
  const root = config.fmpBaseUrl.endsWith("/") ? config.fmpBaseUrl : config.fmpBaseUrl + "/";
  const url = new URL(path, root);
  url.searchParams.set("apikey", config.fmpApiKey);
  return url;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
