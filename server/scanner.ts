import type { Candle, FundamentalFieldSources, Fundamentals, ScanMetadata, ScanMode, ScanResponse, ScanResult, Settings } from "../shared/types";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { createFmpScanFallback, type FmpFundamentals } from "./fmp";
import { activeSqueezeDotCount, latestIndicators } from "./indicators";
import { defaultSettings, gradeSetup } from "./scoring";
import { fetchCallOptions, fetchHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getCachedResults, getScanMetadata, getSetting, replaceScanResults, setScanMetadata, setSetting } from "./sqlite";
import { aggregateDailyCandlesToWeeks } from "./timeframes";
import { getDefaultUniverseSectorMap, getDefaultUniverseStatus, getDefaultUniverseSymbols } from "./universe";

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const SCAN_CONCURRENCY = 4;
const SECTOR_ETF_BY_GICS: Record<string, string> = {
  "Communication Services": "XLC",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  Energy: "XLE",
  Financials: "XLF",
  "Health Care": "XLV",
  Industrials: "XLI",
  "Information Technology": "XLK",
  Materials: "XLB",
  "Real Estate": "XLRE",
  Utilities: "XLU"
};
let activeScan: Promise<void> | null = null;

export async function readSettings(): Promise<Settings> {
  const stored = await getSetting<Partial<Settings>>("settings", {});
  const defaultUniverse = await getDefaultUniverseStatus();
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

export async function writeSettings(input: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    ...current,
    minPrice: input.minPrice ?? current.minPrice,
    minBeta: input.minBeta ?? current.minBeta,
    minMarketCap: input.minMarketCap ?? current.minMarketCap,
    minAvgDollarVolume: input.minAvgDollarVolume ?? current.minAvgDollarVolume,
    useDemoDataWhenMissingApi: input.useDemoDataWhenMissingApi ?? current.useDemoDataWhenMissingApi
  };
  await setSetting("settings", next);
  return readSettings();
}

export async function runScan(): Promise<ScanResponse> {
  return startScanRefresh();
}

export async function startScanRefresh(scanRunner: () => Promise<ScanResponse> = runFullScan): Promise<ScanResponse> {
  if (!activeScan) {
    const startedAt = new Date().toISOString();
    await setScanMetadata({
      ...await readScanMetadata(),
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

export async function readCachedScanResponse(): Promise<ScanResponse> {
  const metadata = await readScanMetadata();
  return {
    mode: metadata.lastScanMode ?? "demo",
    results: await readDisplayResults(),
    settings: await readSettings(),
    warnings: (metadata.lastScanWarnings ?? []).filter(shouldShowWarning),
    ...metadata,
    scanStatus: activeScan ? "running" : metadata.scanStatus,
    isRefreshing: Boolean(activeScan)
  };
}

export async function readScanMetadata(): Promise<ScanMetadata> {
  const stored = await getScanMetadata();
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

export async function shouldAutoRefresh(): Promise<boolean> {
  const cached = await readDisplayResults();
  const metadata = await readScanMetadata();
  if (activeScan) return false;
  if (!hasSchwabCredentials() || !await hasSchwabTokens()) return false;
  if (!cached.length) return true;
  if (!metadata.nextRefreshAt) return true;
  return new Date(metadata.nextRefreshAt).getTime() <= Date.now();
}

export async function runFullScan(): Promise<ScanResponse> {
  const settings = await readSettings();
  const results: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  const symbolsToScan = await resolveScanSymbols();
  const canUseLiveSchwab = hasSchwabCredentials() && await hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();
  const benchmarks = canUseLiveSchwab ? await loadBenchmarks(scanWarnings) : { spyCandles: demoCandles("SPY"), qqqCandles: demoCandles("QQQ") };
  const sectorBySymbol = await getDefaultUniverseSectorMap();
  const sectorHistories = canUseLiveSchwab ? await loadSectorHistories(scanWarnings) : new Map<string, Candle[]>();
  const fmp = canUseLiveSchwab ? await createFmpScanFallback() : undefined;

  if (!canUseLiveSchwab) {
    scanWarnings.add("Automatic screening needs Schwab connected so it can scan the full S&P 500 + Nasdaq 100 universe with live market data.");
  }

  const outcomes = await mapLimit(symbolsToScan, SCAN_CONCURRENCY, (symbol) => {
    const sector = sectorBySymbol[symbol];
    return scanSymbol({
      symbol,
      settings,
      canUseLiveSchwab,
      quote: quoteMap.get(symbol),
      spyCandles: benchmarks.spyCandles,
      qqqCandles: benchmarks.qqqCandles,
      sector,
      sectorCandles: sector ? sectorHistories.get(sector) : undefined,
      sectorHistories,
      fmp
    });
  });

  for (const outcome of outcomes) {
    outcome.warnings.forEach((warning) => scanWarnings.add(warning));
    if (outcome.result && shouldIncludeResult(outcome.result)) results.push(outcome.result);
    if (outcome.usedLive) usedLive = true;
    if (outcome.usedDemo) usedDemo = true;
  }

  const sortByDecision = (a: ScanResult, b: ScanResult) => {
    const gradeDelta = (a.grade === "A" ? 0 : 1) - (b.grade === "A" ? 0 : 1);
    if (gradeDelta !== 0) return gradeDelta;
    const scoreDelta = (b.setupScore ?? -1) - (a.setupScore ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.dailySqueezeDotCount ?? -1) - (a.dailySqueezeDotCount ?? -1);
  };
  if (fmp) await fmp.flush();
  return withScanMetadata({
    mode: usedLive && usedDemo ? "mixed" : usedLive ? "live" : "demo",
    results: results.sort(sortByDecision),
    settings,
    warnings: [...scanWarnings].filter(shouldShowWarning)
  });
}

export async function resolveScanSymbols(): Promise<string[]> {
  return getDefaultUniverseSymbols();
}

export async function readDisplayResults(): Promise<ScanResult[]> {
  return (await getCachedResults())
    .map((result) => normalizeCachedResult(result as ScanResult))
    .filter((result): result is ScanResult => shouldIncludeResult(result));
}

export async function __resetScanStateForTest() {
  activeScan = null;
  await setScanMetadata({ scanStatus: "idle" });
}

async function executeScanRefresh(scanRunner: () => Promise<ScanResponse>, startedAt: string): Promise<void> {
  try {
    const response = await scanRunner();
    await replaceScanResults(response.results);
    const finishedAt = new Date().toISOString();
    await setScanMetadata({
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
    await setScanMetadata({
      ...await readScanMetadata(),
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
  spyCandles?: Awaited<ReturnType<typeof fetchHistory>>;
  qqqCandles?: Awaited<ReturnType<typeof fetchHistory>>;
  sector?: string;
  sectorCandles?: Candle[];
  sectorHistories?: Map<string, Candle[]>;
  fmp?: Awaited<ReturnType<typeof createFmpScanFallback>>;
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
    if (quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
      warnings.push(symbol + ": skipped because Schwab average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
      return { warnings, usedLive, usedDemo };
    }

    const earlyFmp = await input.fmp?.enrich(symbol, {
      beta: quote?.beta === undefined,
      marketCap: quote?.marketCap === undefined
    });
    earlyFmp?.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
    if (earlyFmp?.usedLive) usedLive = true;
    let fundamentals = mergeFundamentals(symbol, quote, earlyFmp?.data);

    if (fundamentals.beta !== undefined && fundamentals.sources?.beta !== "demo" && fundamentals.beta < settings.minBeta) {
      warnings.push(symbol + ": skipped because " + sourceLabel(fundamentals.sources?.beta) + " beta is below " + settings.minBeta + ".");
      return { warnings, usedLive, usedDemo };
    }
    if (fundamentals.marketCap !== undefined && fundamentals.sources?.marketCap !== "demo" && fundamentals.marketCap < settings.minMarketCap) {
      warnings.push(symbol + ": skipped because " + sourceLabel(fundamentals.sources?.marketCap) + " market cap is below " + formatMoney(settings.minMarketCap) + ".");
      return { warnings, usedLive, usedDemo };
    }

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
    const weekly = weeklySqueezeFromDaily(candles);

    let options: Awaited<ReturnType<typeof fetchCallOptions>> = [];
    if (canUseLiveSchwab) {
      try {
        options = await fetchCallOptions(symbol, price);
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

    const contextFmp = await input.fmp?.enrich(symbol, {
      sector: !input.sector && fundamentals.sources?.sector !== "fmp",
      lastEarningsDate: true
    });
    contextFmp?.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
    if (contextFmp?.usedLive) usedLive = true;
    if (contextFmp?.data) {
      fundamentals = mergeFundamentals(symbol, quote, {
        ...(earlyFmp?.data ?? { symbol }),
        ...contextFmp.data,
        symbol
      });
    }

    const sector = input.sector ?? fundamentals.sector;
    const result = gradeSetup({
      symbol,
      companyName: quote?.companyName,
      candles,
      currentPrice: price,
      fundamentals,
      optionable: options.length > 0,
      options,
      weeklyIndicators: weekly.indicators,
      weeklySqueezeWarning: weekly.warning,
      spyCandles: input.spyCandles,
      qqqCandles: input.qqqCandles,
      sector,
      sectorCandles: sector ? input.sectorHistories?.get(sector) ?? input.sectorCandles : undefined
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
      weeklySqueezeWarning: weekly.warning,
      spyCandles: input.spyCandles,
      qqqCandles: input.qqqCandles,
      sector: input.sector,
      sectorCandles: input.sectorCandles
    });
    fallback.dataSource = "demo";
    fallback.warnings.push(error instanceof Error ? error.message : "Scan failed.");
    warnings.push(...fallback.warnings.map((warning) => symbol + ": " + warning));
    return { result: fallback, warnings, usedLive, usedDemo: true };
  }
}

function shouldIncludeResult(result: ScanResult): boolean {
  return result.passesUniverse
    && result.setupDirection === "long"
    && (result.longCallDecision === "Strong Long Call Candidate" || result.longCallDecision === "Moderate Long Call Candidate")
    && (result.grade === "A" || result.grade === "B");
}

function normalizeCachedResult(result: ScanResult): ScanResult {
  const dotCount = resolveDailySqueezeDotCount(result);
  const normalized: ScanResult = {
    ...result,
    dailySqueezeDotCount: dotCount ?? result.dailySqueezeDotCount,
    compressionQualityScore: dotCount ?? result.compressionQualityScore,
    maxScore: dotCount === undefined ? result.maxScore : 5,
    setupScore: typeof result.setupScore === "number" ? result.setupScore : result.score,
    setupScoreStatus: result.setupScoreStatus ?? "Insufficient Data",
    institutionalFactors: result.institutionalFactors ?? [],
    alertMessage: normalizeAlertMessage(result, dotCount),
    layerEvaluations: (result.layerEvaluations ?? []).map((layer) => {
      if (layer.layer !== "Compression Quality") return layer;
      return {
        ...layer,
        detail: dotCount === undefined
          ? "Run scan for dot count."
          : layer.status === "Bearish"
            ? "At least 5 consecutive active daily squeeze dots are required; current count is " + dotCount + "."
            : "Daily chart has " + dotCount + " consecutive active squeeze dots."
      };
    })
  };
  return normalized;
}

function resolveDailySqueezeDotCount(result: ScanResult): number | undefined {
  if (typeof result.dailySqueezeDotCount === "number") return result.dailySqueezeDotCount;
  if (!result.candles?.length) return undefined;
  try {
    return activeSqueezeDotCount(result.candles);
  } catch {
    return undefined;
  }
}

function normalizeAlertMessage(result: ScanResult, dotCount: number | undefined): string {
  const dotText = dotCount === undefined ? "Daily squeeze dots need a fresh scan" : dotCount + " active Daily squeeze dots";
  return result.symbol + " " + result.longCallDecision + " at $" + result.price.toFixed(2) + "; " + dotText + ". Watch for controlled consolidation before expansion.";
}

function weeklySqueezeFromDaily(candles: Awaited<ReturnType<typeof fetchHistory>>): { indicators?: ReturnType<typeof latestIndicators>; warning?: string } {
  try {
    return { indicators: latestIndicators(aggregateDailyCandlesToWeeks(candles)) };
  } catch (error) {
    return { warning: readError(error, "Weekly squeeze could not be calculated.") };
  }
}

async function withScanMetadata(input: { mode: ScanMode; results: ScanResult[]; settings: Settings; warnings: string[] }): Promise<ScanResponse> {
  const metadata = await readScanMetadata();
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

async function loadBenchmarks(warnings: Set<string>): Promise<{ spyCandles?: Awaited<ReturnType<typeof fetchHistory>>; qqqCandles?: Awaited<ReturnType<typeof fetchHistory>> }> {
  const output: { spyCandles?: Awaited<ReturnType<typeof fetchHistory>>; qqqCandles?: Awaited<ReturnType<typeof fetchHistory>> } = {};
  try {
    output.spyCandles = await fetchHistory("SPY");
  } catch (error) {
    warnings.add(readError(error, "SPY macro history request failed."));
  }
  try {
    output.qqqCandles = await fetchHistory("QQQ");
  } catch (error) {
    warnings.add(readError(error, "QQQ macro history request failed."));
  }
  return output;
}

async function loadSectorHistories(warnings: Set<string>): Promise<Map<string, Candle[]>> {
  const sectors = Object.keys(SECTOR_ETF_BY_GICS);
  const output = new Map<string, Candle[]>();
  await Promise.all(sectors.map(async (sector) => {
    const etf = SECTOR_ETF_BY_GICS[sector];
    if (!etf) return;
    try {
      output.set(sector, await fetchHistory(etf));
    } catch (error) {
      warnings.add(readError(error, sector + " sector ETF history request failed."));
    }
  }));
  return output;
}

export function mergeFundamentals(symbol: string, quote?: SchwabQuote, fmp?: FmpFundamentals): Fundamentals {
  const demo = demoFundamental(symbol);
  const sources: FundamentalFieldSources = {};
  const beta = valueWithSource(quote?.beta, "schwab", fmp?.beta, "fmp", demo?.beta, "demo", sources, "beta");
  const marketCap = valueWithSource(quote?.marketCap, "schwab", fmp?.marketCap, "fmp", demo?.marketCap, "demo", sources, "marketCap");
  const avgDollarVolume20d = valueWithSource(quote?.avgDollarVolume, "schwab", undefined, "fmp", demo?.avgDollarVolume20d, "demo", sources, "avgDollarVolume20d");
  const lastEarningsDate = valueWithSource(fmp?.lastEarningsDate, "fmp", quote?.lastEarningsDate, "schwab", demo?.lastEarningsDate, "demo", sources, "lastEarningsDate");
  const sector = valueWithSource(undefined, "schwab", fmp?.sector, "fmp", demo?.sector, "demo", sources, "sector");
  return {
    symbol,
    beta,
    marketCap,
    avgDollarVolume20d,
    lastEarningsDate,
    sector,
    sources
  };
}

function valueWithSource<T>(
  primaryValue: T | undefined,
  primarySource: FundamentalFieldSources[keyof FundamentalFieldSources],
  fallbackValue: T | undefined,
  fallbackSource: FundamentalFieldSources[keyof FundamentalFieldSources],
  demoValue: T | undefined,
  demoSource: FundamentalFieldSources[keyof FundamentalFieldSources],
  sources: FundamentalFieldSources,
  key: keyof FundamentalFieldSources
): T | undefined {
  if (primaryValue !== undefined && primaryValue !== null) {
    sources[key] = primarySource;
    return primaryValue;
  }
  if (fallbackValue !== undefined && fallbackValue !== null) {
    sources[key] = fallbackSource;
    return fallbackValue;
  }
  if (demoValue !== undefined && demoValue !== null) {
    sources[key] = demoSource;
    return demoValue;
  }
  return undefined;
}

function sourceLabel(source: FundamentalFieldSources[keyof FundamentalFieldSources]): string {
  if (source === "fmp") return "FMP fallback";
  if (source === "schwab") return "Schwab";
  return "fundamental";
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
  if (!hasSchwabCredentials() || !await hasSchwabTokens()) return;
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
