import type { LowerTimeframeConfluence, ScanMetadata, ScanMode, ScanResponse, ScanResult, Settings } from "../shared/types";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { latestIndicators } from "./indicators";
import { defaultSettings, gradeSetup } from "./scoring";
import { fetchOptions, fetchHistory, fetchIntradayHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getCachedResults, getScanMetadata, getSetting, replaceScanResults, setScanMetadata, setSetting } from "./sqlite";
import { aggregateDailyCandlesToWeeks, buildLowerTimeframeConfluence } from "./timeframes";
import { getDefaultUniverseStatus, getDefaultUniverseSymbols } from "./universe";

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const SCAN_CONCURRENCY = 4;
let activeScan: Promise<void> | null = null;

export function readSettings(): Settings {
  const stored = getSetting<Partial<Settings>>("settings", {});
  const defaultUniverse = getDefaultUniverseStatus();
  return {
    minPrice: stored.minPrice ?? defaultSettings.minPrice,
    minBeta: stored.minBeta ?? defaultSettings.minBeta,
    minMarketCap: stored.minMarketCap ?? defaultSettings.minMarketCap,
    minAvgDollarVolume: stored.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume,
    brokerBaseUrl: config.schwabMarketDataBaseUrl,
    brokerCallbackUrl: config.schwabCallbackUrl,
    hasBrokerCredentials: hasSchwabCredentials(),
    useDemoDataWhenMissingApi: stored.useDemoDataWhenMissingApi ?? defaultSettings.useDemoDataWhenMissingApi,
    defaultUniverseName: defaultUniverse.name,
    defaultUniverseCount: defaultUniverse.count,
    defaultUniverseLastCheckedAt: defaultUniverse.lastCheckedAt
  };
}

export function writeSettings(input: Partial<Settings>): Settings {
  const current = readSettings();
  const next: Settings = {
    ...current,
    minPrice: input.minPrice ?? current.minPrice,
    minBeta: input.minBeta ?? current.minBeta,
    minMarketCap: input.minMarketCap ?? current.minMarketCap,
    minAvgDollarVolume: input.minAvgDollarVolume ?? current.minAvgDollarVolume,
    useDemoDataWhenMissingApi: input.useDemoDataWhenMissingApi ?? current.useDemoDataWhenMissingApi
  };
  setSetting("settings", next);
  return readSettings();
}

export async function runScan(): Promise<ScanResponse> {
  return startScanRefresh();
}

export function startScanRefresh(scanRunner: () => Promise<ScanResponse> = runFullScan): ScanResponse {
  if (!activeScan) {
    const startedAt = new Date().toISOString();
    setScanMetadata({
      ...readScanMetadata(),
      scanStatus: "running",
      lastScanStartedAt: startedAt,
      isRefreshing: true
    });
    activeScan = executeScanRefresh(scanRunner, startedAt).finally(() => {
      activeScan = null;
    });
  }
  return readCachedScanResponse();
}

export function readCachedScanResponse(): ScanResponse {
  const metadata = readScanMetadata();
  return {
    mode: metadata.lastScanMode ?? "demo",
    results: readDisplayResults(),
    settings: readSettings(),
    warnings: (metadata.lastScanWarnings ?? []).filter(shouldShowWarning),
    ...metadata,
    scanStatus: activeScan ? "running" : metadata.scanStatus,
    isRefreshing: Boolean(activeScan)
  };
}

export function readScanMetadata(): ScanMetadata {
  const stored = getScanMetadata();
  return {
    scanStatus: stored.scanStatus ?? "idle",
    lastScanStartedAt: stored.lastScanStartedAt,
    lastScanFinishedAt: stored.lastScanFinishedAt,
    lastScanMode: stored.lastScanMode,
    lastScanWarnings: (stored.lastScanWarnings ?? []).filter(shouldShowWarning),
    nextRefreshAt: stored.nextRefreshAt,
    isRefreshing: Boolean(activeScan)
  };
}

export function shouldAutoRefresh(): boolean {
  const cached = readDisplayResults();
  const metadata = readScanMetadata();
  if (activeScan) return false;
  if (!hasSchwabCredentials() || !hasSchwabTokens()) return false;
  if (!cached.length) return true;
  if (!metadata.nextRefreshAt) return true;
  return new Date(metadata.nextRefreshAt).getTime() <= Date.now();
}

export async function runFullScan(): Promise<ScanResponse> {
  const settings = readSettings();
  const results: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  const symbolsToScan = resolveScanSymbols();
  const canUseLiveSchwab = hasSchwabCredentials() && hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();

  if (!canUseLiveSchwab) {
    scanWarnings.add("Automatic screening needs Schwab connected so it can scan the full S&P 500 + Nasdaq 100 universe with live market data.");
  }

  const outcomes = await mapLimit(symbolsToScan, SCAN_CONCURRENCY, (symbol) => scanSymbol({
    symbol,
    settings,
    canUseLiveSchwab,
    quote: quoteMap.get(symbol)
  }));

  for (const outcome of outcomes) {
    outcome.warnings.forEach((warning) => scanWarnings.add(warning));
    if (outcome.result && shouldIncludeResult(outcome.result)) results.push(outcome.result);
    if (outcome.usedLive) usedLive = true;
    if (outcome.usedDemo) usedDemo = true;
  }

  const sortByScore = (a: ScanResult, b: ScanResult) => b.score / b.maxScore - a.score / a.maxScore;
  return withScanMetadata({
    mode: usedLive && usedDemo ? "mixed" : usedLive ? "live" : "demo",
    results: results.sort(sortByScore),
    settings,
    warnings: [...scanWarnings].filter(shouldShowWarning)
  });
}

export function resolveScanSymbols(): string[] {
  return getDefaultUniverseSymbols();
}

export function readDisplayResults(): ScanResult[] {
  return getCachedResults().filter((result): result is ScanResult => shouldIncludeResult(result as ScanResult));
}

export function __resetScanStateForTest() {
  activeScan = null;
  setScanMetadata({ scanStatus: "idle" });
}

async function executeScanRefresh(scanRunner: () => Promise<ScanResponse>, startedAt: string): Promise<void> {
  try {
    const response = await scanRunner();
    replaceScanResults(response.results);
    const finishedAt = new Date().toISOString();
    setScanMetadata({
      scanStatus: "complete",
      lastScanStartedAt: startedAt,
      lastScanFinishedAt: finishedAt,
      lastScanMode: response.mode,
      lastScanWarnings: response.warnings,
      nextRefreshAt: new Date(Date.now() + AUTO_REFRESH_MS).toISOString(),
      isRefreshing: false
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    setScanMetadata({
      ...readScanMetadata(),
      scanStatus: "failed",
      lastScanStartedAt: startedAt,
      lastScanFinishedAt: finishedAt,
      lastScanWarnings: [readError(error, "Scan failed.")].filter(shouldShowWarning),
      nextRefreshAt: new Date(Date.now() + AUTO_REFRESH_MS).toISOString(),
      isRefreshing: false
    });
  }
}

async function scanSymbol(input: {
  symbol: string;
  settings: Settings;
  canUseLiveSchwab: boolean;
  quote?: SchwabQuote;
}): Promise<{ result?: ScanResult; warnings: string[]; usedLive: boolean; usedDemo: boolean }> {
  const { symbol, settings, canUseLiveSchwab } = input;
  const warnings: string[] = [];
  let usedLive = false;
  let usedDemo = false;
  let candlesSource: "schwab" | "demo" = "demo";
  let optionsSource: "schwab" | "demo" = "demo";
  let quote = input.quote;
  const allowDemoFallback = settings.useDemoDataWhenMissingApi && (!canUseLiveSchwab || Boolean(demoFundamental(symbol)));

  try {
    if (canUseLiveSchwab && !quote) {
      try {
        quote = await fetchQuote(symbol);
      } catch (error) {
        warnings.push(symbol + ": " + readError(error, "Schwab quote request failed."));
      }
    }

    if (canUseLiveSchwab && !quote) {
      warnings.push(symbol + ": Schwab did not return a quote; skipped.");
      return { warnings, usedLive, usedDemo };
    }

    if (quote && quote.price <= settings.minPrice) {
      warnings.push(symbol + ": skipped because Schwab quote price $" + quote.price.toFixed(2) + " is below $" + settings.minPrice + ".");
      return { warnings, usedLive, usedDemo };
    }
    if (quote?.beta !== undefined && quote.beta < settings.minBeta) {
      warnings.push(symbol + ": skipped because Schwab beta is below " + settings.minBeta + ".");
      return { warnings, usedLive, usedDemo };
    }
    if (quote?.marketCap !== undefined && quote.marketCap < settings.minMarketCap) {
      warnings.push(symbol + ": skipped because Schwab market cap is below " + formatMoney(settings.minMarketCap) + ".");
      return { warnings, usedLive, usedDemo };
    }
    if (quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
      warnings.push(symbol + ": skipped because Schwab average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
      return { warnings, usedLive, usedDemo };
    }

    const lowerTimeframeWarnings: string[] = [];
    const lowerTimeframePromise = canUseLiveSchwab ? loadLowerTimeframeConfluence(symbol, lowerTimeframeWarnings) : Promise.resolve(undefined);
    let candles = canUseLiveSchwab ? await fetchHistory(symbol) : [];
    if (candles.length >= 50) {
      candlesSource = "schwab";
      usedLive = true;
    }
    if (candles.length < 50 && allowDemoFallback) {
      if (canUseLiveSchwab) warnings.push(symbol + ": Schwab returned fewer than 50 historical candles; demo candles were used.");
      candles = demoCandles(symbol);
      candlesSource = "demo";
      usedDemo = true;
    }
    if (candles.length < 50) throw new Error("Not enough candle history.");

    const price = quote?.price ?? candles[candles.length - 1].close;
    if (quote) candles[candles.length - 1] = { ...candles[candles.length - 1], close: quote.price };
    const weekly = weeklySqueezeFromDaily(candles);
    const lowerTimeframes = await lowerTimeframePromise;
    warnings.push(...lowerTimeframeWarnings.map((warning) => symbol + ": " + warning));

    let options: Awaited<ReturnType<typeof fetchOptions>> = [];
    if (canUseLiveSchwab) {
      try {
        options = await fetchOptions(symbol, price);
        if (options.length) {
          optionsSource = "schwab";
          usedLive = true;
        }
      } catch (error) {
        warnings.push(symbol + ": " + readError(error, "Schwab options request failed."));
      }
    }
    if (!options.length && allowDemoFallback) {
      if (canUseLiveSchwab) warnings.push(symbol + ": No live Schwab option contracts met the filters; demo contracts were used.");
      options = demoOptions(symbol, price);
      optionsSource = "demo";
      usedDemo = true;
    }

    const result = gradeSetup({
      symbol,
      companyName: quote?.companyName,
      candles,
      fundamentals: mergeFundamentals(symbol, quote),
      optionable: options.length > 0,
      options,
      lowerTimeframes,
      weeklyIndicators: weekly.indicators,
      weeklySqueezeWarning: weekly.warning
    });
    result.dataSource = candlesSource === "schwab" && optionsSource === "schwab" ? "schwab" : candlesSource === "demo" && optionsSource === "demo" ? "demo" : "mixed";
    result.warnings.push(...warnings
      .filter((warning) => warning.startsWith(symbol + ": "))
      .map((warning) => warning.slice(symbol.length + 2))
      .filter(shouldShowWarning));
    await throttleIfLive();
    return { result, warnings, usedLive, usedDemo };
  } catch (error) {
    if (canUseLiveSchwab) {
      warnings.push(symbol + ": " + (error instanceof Error ? error.message : "Scan failed."));
      return { warnings, usedLive, usedDemo };
    }
    if (!allowDemoFallback || !demoFundamental(symbol)) return { warnings, usedLive, usedDemo };
    const candles = demoCandles(symbol);
    const price = candles[candles.length - 1].close;
    const weekly = weeklySqueezeFromDaily(candles);
    const fallback = gradeSetup({
      symbol,
      candles,
      fundamentals: demoFundamental(symbol),
      optionable: settings.useDemoDataWhenMissingApi,
      options: settings.useDemoDataWhenMissingApi ? demoOptions(symbol, price) : [],
      weeklyIndicators: weekly.indicators,
      weeklySqueezeWarning: weekly.warning
    });
    fallback.dataSource = "demo";
    fallback.warnings.push(error instanceof Error ? error.message : "Scan failed.");
    warnings.push(...fallback.warnings.map((warning) => symbol + ": " + warning));
    return { result: fallback, warnings, usedLive, usedDemo: true };
  }
}

function shouldIncludeResult(result: ScanResult): boolean {
  return result.passesUniverse
    && result.grade !== "D"
    && result.grade !== "F";
}

function weeklySqueezeFromDaily(candles: Awaited<ReturnType<typeof fetchHistory>>): { indicators?: ReturnType<typeof latestIndicators>; warning?: string } {
  try {
    return { indicators: latestIndicators(aggregateDailyCandlesToWeeks(candles)) };
  } catch (error) {
    return { warning: readError(error, "Weekly squeeze could not be calculated.") };
  }
}

function withScanMetadata(input: { mode: ScanMode; results: ScanResult[]; settings: Settings; warnings: string[] }): ScanResponse {
  const metadata = readScanMetadata();
  return {
    ...input,
    ...metadata,
    scanStatus: activeScan ? "running" : metadata.scanStatus,
    isRefreshing: Boolean(activeScan)
  };
}

function readError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function loadQuoteMap(symbols: string[], warnings: Set<string>): Promise<Map<string, SchwabQuote>> {
  try {
    return await fetchQuotes(symbols);
  } catch (error) {
    warnings.add(readError(error, "Schwab batch quote request failed."));
    return new Map();
  }
}

async function loadLowerTimeframeConfluence(symbol: string, warnings: string[]): Promise<LowerTimeframeConfluence | undefined> {
  try {
    const intradayCandles = await fetchIntradayHistory(symbol);
    const confluence = buildLowerTimeframeConfluence(intradayCandles);
    if (confluence.oneHour.bias === "unavailable") warnings.push("1h confluence unavailable: " + confluence.oneHour.detail);
    if (confluence.fourHour.bias === "unavailable") warnings.push("4h confluence unavailable: " + confluence.fourHour.detail);
    return confluence;
  } catch (error) {
    warnings.push(readError(error, "Schwab intraday history request failed."));
    return undefined;
  }
}

function mergeFundamentals(symbol: string, quote?: SchwabQuote) {
  const demo = demoFundamental(symbol);
  return {
    symbol,
    beta: quote?.beta ?? demo?.beta,
    marketCap: quote?.marketCap ?? demo?.marketCap,
    avgDollarVolume20d: quote?.avgDollarVolume ?? demo?.avgDollarVolume20d
  };
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}

async function throttleIfLive() {
  if (!hasSchwabCredentials() || !hasSchwabTokens()) return;
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function shouldShowWarning(warning: string): boolean {
  const internalMessages = [
    "database is locked",
    "screener.sqlite",
    "Command failed: sqlite3",
    "SELECT value FROM settings",
    "schwabTokens"
  ];
  const routineSkips = [
    "Schwab did not return a quote; skipped.",
    "skipped because Schwab quote price",
    "skipped because Schwab average dollar volume"
  ];
  if (internalMessages.some((message) => warning.includes(message))) return false;
  return !routineSkips.some((message) => warning.includes(message));
}
