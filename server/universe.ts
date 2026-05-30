import { defaultUniverseName, defaultUniverseSymbols } from "./defaultUniverse";
import { getSetting, setSetting } from "./sqlite";

type UniverseCache = {
  symbols: string[];
  updatedAt: string;
  source: string;
  added: string[];
  removed: string[];
};

const UNIVERSE_SETTING = "defaultUniverseCache";
const MIN_REFRESHED_SYMBOLS = 450;

export function getDefaultUniverseName(): string {
  return defaultUniverseName;
}

export function getDefaultUniverseSymbols(): string[] {
  const cached = getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined);
  if (cached && cached.symbols.length >= MIN_REFRESHED_SYMBOLS) return cached.symbols;
  return defaultUniverseSymbols;
}

export function getDefaultUniverseStatus() {
  const cached = getSetting<UniverseCache | undefined>(UNIVERSE_SETTING, undefined);
  return {
    name: defaultUniverseName,
    count: getDefaultUniverseSymbols().length,
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
  const refreshed = normalizeSymbols([
    ...parseSp500Symbols(sp500Html),
    ...parseNasdaq100Symbols(nasdaqHtml)
  ]);
  if (refreshed.length < MIN_REFRESHED_SYMBOLS) {
    throw new Error(`Default universe refresh returned only ${refreshed.length} symbols.`);
  }

  const previous = getDefaultUniverseSymbols();
  const next: UniverseCache = {
    symbols: refreshed,
    updatedAt: new Date().toISOString(),
    source: "public S&P 500 + Nasdaq 100 pages",
    added: refreshed.filter((symbol) => !previous.includes(symbol)),
    removed: previous.filter((symbol) => !refreshed.includes(symbol))
  };
  setSetting(UNIVERSE_SETTING, next);
  return next;
}

export function parseSp500Symbols(html: string): string[] {
  const table = html.match(/<table[^>]+id="constituents"[\s\S]*?<\/table>/i)?.[0] ?? html;
  const symbols = [...table.matchAll(/<td>\s*<a[^>]*>\s*([A-Z][A-Z.]{0,5})\s*<\/a>\s*<\/td>/g)].map((match) => match[1]);
  return normalizeSymbols(symbols);
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Trade-Screener/1.0"
    }
  });
  if (!response.ok) throw new Error(`Universe source request failed: ${response.status} ${response.statusText}`);
  return response.text();
}
