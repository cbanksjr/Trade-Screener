import { defaultUniverseName, defaultUniverseSymbols } from "./defaultUniverse";
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
const MIN_REFRESHED_SYMBOLS = 450;

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
  const [sp500Html, nasdaqHtml] = await Promise.all([
    fetchText("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"),
    fetchText("https://stockanalysis.com/list/nasdaq-100-stocks/")
  ]);
  const sp500 = parseSp500Constituents(sp500Html);
  const refreshed = normalizeSymbols([
    ...sp500.symbols,
    ...parseNasdaq100Symbols(nasdaqHtml)
  ]);
  if (refreshed.length < MIN_REFRESHED_SYMBOLS) {
    throw new Error(`Default universe refresh returned only ${refreshed.length} symbols.`);
  }

  const previous = await getDefaultUniverseSymbols();
  const next: UniverseCache = {
    symbols: refreshed,
    updatedAt: new Date().toISOString(),
    source: "public S&P 500 + Nasdaq 100 pages",
    added: refreshed.filter((symbol) => !previous.includes(symbol)),
    removed: previous.filter((symbol) => !refreshed.includes(symbol)),
    sectorBySymbol: sp500.sectorBySymbol
  };
  await setSetting(UNIVERSE_SETTING, next);
  return next;
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

export function isLastDayOfMonth(date = new Date()): boolean {
  const tomorrow = new Date(date);
  tomorrow.setDate(date.getDate() + 1);
  return tomorrow.getMonth() !== date.getMonth();
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Trade-Screener/1.0"
    }
  });
  if (!response.ok) throw new Error(`Universe source request failed: ${response.status} ${response.statusText}`);
  return response.text();
}
