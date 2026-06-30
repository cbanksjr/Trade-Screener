import type { AssetType, Candle, FundamentalFieldSources, Fundamentals, IndicatorSnapshot, ScanDiagnosticCounts, ScanDiagnostics, ScanMetadata, ScanMode, ScanResponse, ScanResult, Settings } from "../shared/types";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { resolveEtfSymbols } from "./etfUniverse";
import { createFmpScanFallback, type FmpFundamentals } from "./fmp";
import { createFmpInstitutionalEdgeScanProvider } from "./fmpInstitutionalEdge";
import { activeSqueezeDotCount, latestIndicators } from "./indicators";
import { createQuantDataPositioningScanProvider } from "./quantData";
import {
  A_SETUP_SCORE_THRESHOLD,
  BEARISH_MACRO_GRADE_CAP_REASON,
  B_SETUP_SCORE_THRESHOLD,
  BROAD_ENTRY_GRADE_CAP_REASON,
  DEVELOPING_SQUEEZE_GRADE_CAP_REASON,
  EXTENDED_ENTRY_GRADE_CAP_REASON,
  RELAXED_TREND_GRADE_CAP_REASON,
  RELAXED_WEEKLY_GRADE_CAP_REASON,
  WEEKLY_ATR_GRADE_CAP_REASON,
  applyInstitutionalEdge,
  applyInstitutionalPositioning,
  defaultSettings,
  gradeSetup,
  isSqueezeActive,
  resolveDailyEntryQualificationMode,
  resolveSqueezeMaturityMode,
  resolveWeeklyQualificationMode,
  stockLiquidityPasses
} from "./scoring";
import { fetchCallOptions, fetchHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getCachedResults, getScanMetadata, getSetting, replaceScanResults, setScanMetadata, setSetting } from "./sqlite";
import { aggregateDailyCandlesToWeeks } from "./timeframes";
import { getDefaultUniverseSectorMap, getDefaultUniverseStatus, getDefaultUniverseSymbols, MIN_REFRESHED_SYMBOLS } from "./universe";

const AUTO_REFRESH_MS = 15 * 60 * 1000;
const SCAN_CONCURRENCY = 4;
const OLD_DEFAULT_MIN_AVG_DOLLAR_VOLUME = 600_000_000;
type ScanDiagnosticReason = keyof ScanDiagnosticCounts;
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
  const normalizedStored = stored.minAvgDollarVolume === OLD_DEFAULT_MIN_AVG_DOLLAR_VOLUME
    ? { ...stored, minAvgDollarVolume: defaultSettings.minAvgDollarVolume }
    : stored;
  if (normalizedStored !== stored) await setSetting("settings", normalizedStored);
  const defaultUniverse = await getDefaultUniverseStatus();
  const etfSymbols = resolveEtfSymbols(normalizedStored.etfSymbols);
  return {
    minPrice: normalizedStored.minPrice ?? defaultSettings.minPrice,
    minBeta: normalizedStored.minBeta ?? defaultSettings.minBeta,
    minMarketCap: normalizedStored.minMarketCap ?? defaultSettings.minMarketCap,
    minAvgShareVolume: normalizedStored.minAvgShareVolume ?? defaultSettings.minAvgShareVolume,
    minAvgDollarVolume: normalizedStored.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume,
    brokerBaseUrl: config.schwabMarketDataBaseUrl,
    brokerCallbackUrl: config.schwabCallbackUrl,
    hasBrokerCredentials: hasSchwabCredentials(),
    useDemoDataWhenMissingApi: normalizedStored.useDemoDataWhenMissingApi ?? defaultSettings.useDemoDataWhenMissingApi,
    etfSymbols,
    defaultUniverseName: defaultUniverse.name + " + selected ETFs",
    defaultUniverseCount: defaultUniverse.count + etfSymbols.length,
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
    minAvgShareVolume: input.minAvgShareVolume ?? current.minAvgShareVolume,
    minAvgDollarVolume: input.minAvgDollarVolume ?? current.minAvgDollarVolume,
    useDemoDataWhenMissingApi: input.useDemoDataWhenMissingApi ?? current.useDemoDataWhenMissingApi,
    etfSymbols: input.etfSymbols ? resolveEtfSymbols(input.etfSymbols) : current.etfSymbols
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
    scanDiagnostics: stored.scanDiagnostics,
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
  const scanRanAt = new Date();
  const settings = await readSettings();
  const results: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  const etfSymbols = settings.etfSymbols;
  const etfSymbolSet = new Set(etfSymbols);
  const symbolsToScan = await resolveScanSymbols(settings);
  const stockSymbolsToScan = symbolsToScan.filter((symbol) => !etfSymbolSet.has(symbol));
  const diagnostics = createScanDiagnostics(symbolsToScan.length, settings.minAvgShareVolume, settings.minAvgDollarVolume);
  if (symbolsToScan.length < MIN_REFRESHED_SYMBOLS) {
    scanWarnings.add("Scan universe contains only " + symbolsToScan.length + " symbols; expected at least " + MIN_REFRESHED_SYMBOLS + ".");
  }
  const canUseLiveSchwab = hasSchwabCredentials() && await hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();
  const benchmarks = canUseLiveSchwab ? await loadBenchmarks(scanWarnings) : { spyCandles: demoCandles("SPY"), qqqCandles: demoCandles("QQQ") };
  const sectorBySymbol = await getDefaultUniverseSectorMap();
  const sectorHistories = canUseLiveSchwab ? await loadSectorHistories(scanWarnings) : new Map<string, Candle[]>();
  const fmp = canUseLiveSchwab ? await createFmpScanFallback() : undefined;
  const fmpInstitutionalEdge = canUseLiveSchwab ? await createFmpInstitutionalEdgeScanProvider() : undefined;
  const quantDataPositioning = canUseLiveSchwab ? await createQuantDataPositioningScanProvider() : undefined;
  const fmpEarnings = fmp && stockSymbolsToScan.length ? await fmp.earningsCalendar(stockSymbolsToScan) : undefined;
  const earningsBySymbol = fmpEarnings?.earningsBySymbol ?? new Map<string, string>();
  fmpEarnings?.warnings.forEach((warning) => scanWarnings.add(warning));
  if (fmpEarnings?.usedLive) usedLive = true;

  if (!canUseLiveSchwab) {
    scanWarnings.add("Automatic screening needs Schwab connected so it can scan the full S&P 500 + Nasdaq 100 + selected ETF universe with live market data.");
  }

  const outcomes = await mapLimit(symbolsToScan, SCAN_CONCURRENCY, (symbol) => {
    const sector = sectorBySymbol[symbol];
    const assetType: AssetType = etfSymbolSet.has(symbol) ? "etf" : "stock";
    return scanSymbol({
      symbol,
      assetType,
      settings,
      canUseLiveSchwab,
      quote: quoteMap.get(symbol),
      spyCandles: benchmarks.spyCandles,
      qqqCandles: benchmarks.qqqCandles,
      sector,
      sectorCandles: sector ? sectorHistories.get(sector) : undefined,
      sectorHistories,
      nextEarningsDate: earningsBySymbol.get(symbol),
      fmp,
      scanRanAt
    });
  });

  for (const outcome of outcomes) {
    outcome.warnings.forEach((warning) => scanWarnings.add(warning));
    if (outcome.skipReason) diagnostics.skipped[outcome.skipReason] += 1;
    if (outcome.result && shouldIncludeResult(outcome.result)) {
      let result = outcome.result;
      if (fmpInstitutionalEdge) {
        const edge = await fmpInstitutionalEdge.enrich(result.symbol, result.assetType, result.price);
        if (edge.usedLive) usedLive = true;
        result = applyInstitutionalEdge(result, edge.edge);
      }
      if (quantDataPositioning) {
        const positioning = await quantDataPositioning.enrich(result.symbol, result.price);
        if (positioning.usedLive) usedLive = true;
        result = applyInstitutionalPositioning(result, positioning.positioning);
      }
      if (shouldIncludeResult(result)) results.push(result);
      else diagnostics.skipped[classifyFilteredResult(result)] += 1;
    } else if (outcome.result) diagnostics.skipped[classifyFilteredResult(outcome.result)] += 1;
    else if (!outcome.skipReason) diagnostics.skipped.other += 1;
    if (outcome.usedLive) usedLive = true;
    if (outcome.usedDemo) usedDemo = true;
  }
  diagnostics.qualifiedResults = results.length;

  const sortByDecision = (a: ScanResult, b: ScanResult) => {
    const scoreDelta = (b.setupScore ?? -1) - (a.setupScore ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    const gradeDelta = (a.grade === "A" ? 0 : 1) - (b.grade === "A" ? 0 : 1);
    if (gradeDelta !== 0) return gradeDelta;
    return (b.dailySqueezeDotCount ?? -1) - (a.dailySqueezeDotCount ?? -1);
  };
  if (fmp) await fmp.flush();
  if (fmpInstitutionalEdge) await fmpInstitutionalEdge.flush();
  if (quantDataPositioning) await quantDataPositioning.flush();
  return withScanMetadata({
    mode: usedLive && usedDemo ? "mixed" : usedLive ? "live" : "demo",
    results: results.sort(sortByDecision),
    settings,
    warnings: [...scanWarnings].filter(shouldShowWarning),
    scanDiagnostics: diagnostics
  });
}

export async function resolveScanSymbols(inputSettings?: Settings): Promise<string[]> {
  const settings = inputSettings ?? await readSettings();
  return mergeSymbols(await getDefaultUniverseSymbols(), settings.etfSymbols);
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
      scanDiagnostics: response.scanDiagnostics,
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
  assetType: AssetType;
  settings: Settings;
  canUseLiveSchwab: boolean;
  quote?: SchwabQuote;
  spyCandles?: Awaited<ReturnType<typeof fetchHistory>>;
  qqqCandles?: Awaited<ReturnType<typeof fetchHistory>>;
  sector?: string;
  sectorCandles?: Candle[];
  sectorHistories?: Map<string, Candle[]>;
  nextEarningsDate?: string;
  fmp?: Awaited<ReturnType<typeof createFmpScanFallback>>;
  scanRanAt?: Date;
}): Promise<{ result?: ScanResult; warnings: string[]; usedLive: boolean; usedDemo: boolean; skipReason?: ScanDiagnosticReason }> {
  const { symbol, settings, canUseLiveSchwab, assetType } = input;
  const scanRanAt = input.scanRanAt ?? new Date();
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
      return { warnings, usedLive, usedDemo, skipReason: "quoteMissing" };
    }

    if (quote && quote.price <= settings.minPrice) {
      warnings.push(symbol + ": skipped because Schwab quote price $" + quote.price.toFixed(2) + " is below $" + settings.minPrice + ".");
      return { warnings, usedLive, usedDemo, skipReason: "price" };
    }
    if (assetType === "etf" && quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
      warnings.push(symbol + ": skipped because ETF average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
      return { warnings, usedLive, usedDemo, skipReason: "stockLiquidity" };
    }
    if (
      assetType === "stock"
      && quote?.averageVolume !== undefined
      && quote.avgDollarVolume !== undefined
      && !stockLiquidityPasses(quote.averageVolume, quote.avgDollarVolume, settings.minAvgShareVolume, settings.minAvgDollarVolume)
    ) {
      warnings.push(symbol + ": skipped because average share volume and average dollar volume are below the configured liquidity thresholds.");
      return { warnings, usedLive, usedDemo, skipReason: "stockLiquidity" };
    }

    const earlyFmp = assetType === "stock" ? await input.fmp?.enrich(symbol, {
      beta: assetType === "stock" && quote?.beta === undefined,
      marketCap: assetType === "stock" && quote?.marketCap === undefined,
      averageVolume: assetType === "stock" && quote?.averageVolume === undefined
    }) : undefined;
    earlyFmp?.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
    if (earlyFmp?.usedLive) usedLive = true;
    let fundamentals = mergeFundamentals(symbol, quote, earlyFmp?.data);

    if (assetType === "stock" && fundamentals.marketCap !== undefined && fundamentals.sources?.marketCap !== "demo" && fundamentals.marketCap < settings.minMarketCap) {
      warnings.push(symbol + ": skipped because " + sourceLabel(fundamentals.sources?.marketCap) + " market cap is below " + formatMoney(settings.minMarketCap) + ".");
      return { warnings, usedLive, usedDemo, skipReason: "marketCap" };
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
    fundamentals = withCandleLiquidityFallback(fundamentals, candles);
    const liquidityPasses = assetType === "etf"
      ? (fundamentals.avgDollarVolume20d ?? 0) >= settings.minAvgDollarVolume
      : stockLiquidityPasses(fundamentals.avgShareVolume, fundamentals.avgDollarVolume20d, settings.minAvgShareVolume, settings.minAvgDollarVolume);
    if (!liquidityPasses) {
      warnings.push(symbol + ": skipped because average share volume is below " + formatShares(settings.minAvgShareVolume)
        + " and average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
      return { warnings, usedLive, usedDemo, skipReason: "stockLiquidity" };
    }
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

    const contextFmp = assetType === "stock" ? await input.fmp?.enrich(symbol, {
      sector: assetType === "stock" && !input.sector && fundamentals.sources?.sector !== "fmp",
      nextEarningsDate: assetType === "stock" && !input.nextEarningsDate
    }) : undefined;
    contextFmp?.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
    if (contextFmp?.usedLive) usedLive = true;
    if (contextFmp?.data) {
      fundamentals = mergeFundamentals(symbol, quote, {
        ...(earlyFmp?.data ?? { symbol }),
        ...contextFmp.data,
        nextEarningsDate: input.nextEarningsDate ?? contextFmp.data.nextEarningsDate,
        symbol
      });
    }
    if (input.nextEarningsDate && fundamentals.sources?.nextEarningsDate !== "fmp") {
      fundamentals = mergeFundamentals(symbol, quote, {
        ...(earlyFmp?.data ?? { symbol }),
        ...(contextFmp?.data ?? {}),
        nextEarningsDate: input.nextEarningsDate,
        symbol
      });
    }
    fundamentals = withCandleLiquidityFallback(fundamentals, candles);

    const buildResult = (fundamentalData: Fundamentals) => {
      const sector = input.sector ?? fundamentalData.sector;
      return gradeSetup({
        symbol,
        companyName: quote?.companyName,
        assetType,
        candles,
        currentPrice: price,
        fundamentals: fundamentalData,
        optionable: options.length > 0,
        options,
        weeklyIndicators: weekly.indicators,
        weeklySqueezeWarning: weekly.warning,
        spyCandles: input.spyCandles,
        qqqCandles: input.qqqCandles,
        sector,
        sectorCandles: sector ? input.sectorHistories?.get(sector) ?? input.sectorCandles : undefined,
        minMarketCap: settings.minMarketCap,
        minBeta: settings.minBeta,
        minAvgShareVolume: settings.minAvgShareVolume,
        minAvgDollarVolume: settings.minAvgDollarVolume,
        scanRanAt
      });
    };

    let result = buildResult(fundamentals);
    if (assetType === "stock" && input.fmp && shouldIncludeResult(result)) {
      const verified = await input.fmp.verifyNextEarningsDate(symbol, fundamentals.nextEarningsDate);
      verified.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
      if (verified.usedLive) usedLive = true;
      const verifiedDate = verified.data?.nextEarningsDate;
      if (verifiedDate && verifiedDate !== fundamentals.nextEarningsDate) {
        fundamentals = mergeFundamentals(symbol, quote, {
          ...(earlyFmp?.data ?? { symbol }),
          ...(contextFmp?.data ?? {}),
          nextEarningsDate: verifiedDate,
          symbol
        });
        fundamentals = withCandleLiquidityFallback(fundamentals, candles);
        result = buildResult(fundamentals);
      }
    }
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
      const message = error instanceof Error ? error.message : "";
      return { warnings, usedLive, usedDemo, skipReason: message.includes("Not enough candle history") ? "candleHistory" : "other" };
    }
    if (!allowDemoFallback || !demoFundamental(symbol)) return { warnings, usedLive, usedDemo, skipReason: "other" };
    const candles = demoCandles(symbol);
    const price = candles[candles.length - 1].close;
    const weekly = weeklySqueezeFromDaily(candles);
    const fallback = gradeSetup({
      symbol,
      assetType: input.assetType,
      candles,
      fundamentals: demoFundamental(symbol),
      optionable: settings.useDemoDataWhenMissingApi,
      options: settings.useDemoDataWhenMissingApi ? demoOptions(symbol, price) : [],
      weeklyIndicators: weekly.indicators,
      weeklySqueezeWarning: weekly.warning,
      spyCandles: input.spyCandles,
      qqqCandles: input.qqqCandles,
      sector: input.sector,
      sectorCandles: input.sectorCandles,
      scanRanAt
    });
    fallback.dataSource = "demo";
    fallback.assetType = input.assetType;
    fallback.warnings.push(error instanceof Error ? error.message : "Scan failed.");
    warnings.push(...fallback.warnings.map((warning) => symbol + ": " + warning));
    return { result: fallback, warnings, usedLive, usedDemo: true };
  }
}

function shouldIncludeResult(result: ScanResult): boolean {
  return result.passesUniverse
    && result.setupDirection === "long"
    && result.indicators.momentum > 0
    && dailySqueezeCriteriaPass(result)
    && result.dailyEntryQualificationMode !== "none"
    && (result.grade === "A" || result.grade === "B");
}

function dailySqueezeCriteriaPass(result: ScanResult): boolean {
  const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
  if (!isSqueezeActive(daily?.squeezeState === "unavailable" ? undefined : daily?.squeezeState)) return false;
  if (result.squeezeMaturityMode === "insufficient") return false;
  if (typeof result.dailySqueezeDotCount === "number" && result.dailySqueezeDotCount < 2) return false;
  if (result.layerEvaluations?.some((item) => item.layer === "Compression Quality" && item.status === "Bearish")) return false;
  return true;
}

function hasBearishOrUnavailableWeeklyContext(result: ScanResult): boolean {
  const weekly = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "weekly");
  return weekly?.bias === "bearish" || weekly?.bias === "unavailable";
}

function resolveCachedWeeklyQualificationMode(result: ScanResult): NonNullable<ScanResult["weeklyQualificationMode"]> {
  if (result.weeklyQualificationMode) return result.weeklyQualificationMode;
  if (result.weeklyIndicators) {
    try {
      return resolveWeeklyQualificationMode(normalizeCachedIndicators(result.weeklyIndicators), result.price);
    } catch {
      // Fall through to legacy timeframe metadata.
    }
  }
  const weekly = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "weekly");
  return weekly?.bias === "bullish" ? "full-stack" : "none";
}

function createScanDiagnostics(scannedSymbols: number, minAvgShareVolume: number, minAvgDollarVolume: number): ScanDiagnostics {
  return {
    scannedSymbols,
    qualifiedResults: 0,
    minAvgShareVolume,
    minAvgDollarVolume,
    skipped: {
      quoteMissing: 0,
      price: 0,
      stockLiquidity: 0,
      marketCap: 0,
      candleHistory: 0,
      options: 0,
      spreadLiquidity: 0,
      marketStructure: 0,
      catalyst: 0,
      sectorDataCap: 0,
      finalDisplayFilter: 0,
      other: 0
    }
  };
}

function classifyFilteredResult(result: ScanResult): ScanDiagnosticReason {
  const layer = (name: ScanResult["layerEvaluations"][number]["layer"]) => result.layerEvaluations.find((item) => item.layer === name);
  const factor = (name: ScanResult["institutionalFactors"][number]["name"]) => result.institutionalFactors.find((item) => item.name === name);
  if (layer("Options Market Context")?.status === "Bearish") return "options";
  if (layer("Squeeze Market Structure")?.status === "Bearish") return "marketStructure";
  if (factor("Catalyst Safety")?.status === "Bearish") return "catalyst";
  if (factor("Sector Strength")?.status === "Insufficient Data") return "sectorDataCap";
  if (!result.passesUniverse) return "finalDisplayFilter";
  if (result.longCallDecision === "Avoid" || result.longCallDecision === "Watchlist Candidate") return "finalDisplayFilter";
  return "other";
}

function normalizeCachedResult(result: ScanResult): ScanResult {
  const dotCount = resolveDailySqueezeDotCount(result);
  const setupScore = typeof result.setupScore === "number" ? result.setupScore : result.score;
  const weeklyQualificationMode = resolveCachedWeeklyQualificationMode(result);
  const dailyEntryQualificationMode = resolveCachedDailyEntryQualificationMode(result);
  const squeezeMaturityMode = result.squeezeMaturityMode
    ?? (dotCount === undefined ? "mature" : resolveSqueezeMaturityMode(dotCount));
  const bearishMacro = hasBearishMacro(result);
  const missingDailyEmaStack = hasMissingCachedDailyEmaStack(result);
  const scoreGrade = gradeFromSetupScore(setupScore);
  const grade = scoreGrade;
  const gradeCapReasons = mergeCachedGradeCapReasons(result, setupScore, dailyEntryQualificationMode, squeezeMaturityMode, missingDailyEmaStack);
  const tradeMarkReasons = cachedTradeMarkReasons(result, grade, setupScore, bearishMacro);
  const tradeMark = tradeMarkReasons.length ? "Avoid" : "Take";
  const longCallDecision = cachedCompatibilityDecision(grade, tradeMark);
  const normalized: ScanResult = {
    ...result,
    assetType: result.assetType ?? "stock",
    avgShareVolume: result.avgShareVolume ?? averageCandleVolume(result.candles),
    grade,
    longCallDecision,
    setupQuality: grade === "A" ? "High" : "Moderate",
    indicators: normalizeCachedIndicators(result.indicators),
    weeklyIndicators: result.weeklyIndicators ? normalizeCachedIndicators(result.weeklyIndicators) : undefined,
    dailySqueezeDotCount: dotCount ?? result.dailySqueezeDotCount,
    compressionQualityScore: dotCount ?? result.compressionQualityScore,
    maxScore: dotCount === undefined ? result.maxScore : 5,
    setupScore,
    setupScoreStatus: result.setupScoreStatus ?? "Insufficient Data",
    institutionalFactors: result.institutionalFactors ?? [],
    dailyEntryQualificationMode,
    weeklyQualificationMode,
    squeezeMaturityMode,
    tradeMark,
    tradeMarkReasons,
    gradeCapReasons,
    finalGrade: grade,
    strongLongCallCandidate: longCallDecision === "Strong Long Call Candidate",
    flags: result.flags ?? [],
    alertMessage: normalizeAlertMessage(result, dotCount),
    layerEvaluations: (result.layerEvaluations ?? []).map((layer) => {
      if (layer.layer !== "Compression Quality") return layer;
      return {
        ...layer,
        detail: dotCount === undefined
          ? "Run scan for dot count."
          : layer.status === "Bearish"
            ? "At least 2 consecutive active daily squeeze dots are required; current count is " + dotCount + "."
            : dotCount < 5
              ? "Daily squeeze is developing with " + dotCount + " active dots; compression contributes fewer setup points."
              : "Daily chart has " + dotCount + " consecutive active squeeze dots."
      };
    })
  };
  return normalized;
}

function mergeSymbols(stockSymbols: string[], etfSymbols: string[]): string[] {
  return [...new Set([...stockSymbols, ...etfSymbols])].sort();
}

function normalizeCachedIndicators(indicators: IndicatorSnapshot): IndicatorSnapshot {
  const legacy = indicators as IndicatorSnapshot & { ema50?: number; ema100?: number };
  return {
    ...indicators,
    ema50: typeof legacy.ema50 === "number" ? legacy.ema50 : indicators.ema55,
    ema100: typeof legacy.ema100 === "number" ? legacy.ema100 : indicators.ema89
  };
}

function resolveCachedDailyEntryQualificationMode(result: ScanResult): NonNullable<ScanResult["dailyEntryQualificationMode"]> {
  if (result.dailyEntryQualificationMode) return result.dailyEntryQualificationMode;
  try {
    return resolveDailyEntryQualificationMode(normalizeCachedIndicators(result.indicators), result.price);
  } catch {
    const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
    return daily?.withinEmaPocket ? "strict" : "none";
  }
}

function gradeFromSetupScore(setupScore: number): ScanResult["grade"] {
  if (setupScore >= A_SETUP_SCORE_THRESHOLD) return "A";
  if (setupScore >= B_SETUP_SCORE_THRESHOLD) return "B";
  return "C";
}

function cachedGradeCapReasons(result: ScanResult, setupScore: number): string[] {
  const reasons: string[] = [];
  const factor = (name: ScanResult["institutionalFactors"][number]["name"]) => result.institutionalFactors?.find((item) => item.name === name);
  if (setupScore < A_SETUP_SCORE_THRESHOLD) reasons.push("Setup score below 90.");
  if (factor("Sector Strength")?.status === "Insufficient Data") reasons.push("Sector Strength unavailable.");
  if (factor("Catalyst Safety")?.status === "Insufficient Data") reasons.push("Catalyst Safety unavailable.");
  return removeWeeklyCachedGradeReasons(reasons);
}

function mergeCachedGradeCapReasons(
  result: ScanResult,
  setupScore: number,
  dailyEntryQualificationMode: NonNullable<ScanResult["dailyEntryQualificationMode"]>,
  squeezeMaturityMode: NonNullable<ScanResult["squeezeMaturityMode"]>,
  missingDailyEmaStack = false
): string[] {
  const reasons = removeWeeklyCachedGradeReasons(result.gradeCapReasons ?? cachedGradeCapReasons(result, setupScore))
    .filter((reason) => reason !== RELAXED_TREND_GRADE_CAP_REASON || missingDailyEmaStack)
    .filter((reason) => reason !== BEARISH_MACRO_GRADE_CAP_REASON && reason !== "Options Market Context is neutral.");
  if (dailyEntryQualificationMode === "broad" && !reasons.includes(BROAD_ENTRY_GRADE_CAP_REASON)) reasons.push(BROAD_ENTRY_GRADE_CAP_REASON);
  if (dailyEntryQualificationMode === "extended" && !reasons.includes(EXTENDED_ENTRY_GRADE_CAP_REASON)) reasons.push(EXTENDED_ENTRY_GRADE_CAP_REASON);
  if (squeezeMaturityMode === "developing" && !reasons.includes(DEVELOPING_SQUEEZE_GRADE_CAP_REASON)) reasons.push(DEVELOPING_SQUEEZE_GRADE_CAP_REASON);
  if (hasRelaxedMarketStructure(result) && missingDailyEmaStack && !reasons.includes(RELAXED_TREND_GRADE_CAP_REASON)) reasons.push(RELAXED_TREND_GRADE_CAP_REASON);
  return reasons;
}

function cachedTradeMarkReasons(result: ScanResult, grade: ScanResult["grade"], setupScore: number, bearishMacro: boolean): string[] {
  const reasons = (result.tradeMarkReasons ?? []).filter((reason) => reason !== "Institutional Edge is bearish.");
  if (grade === "C" || setupScore < B_SETUP_SCORE_THRESHOLD) addUnique(reasons, "Setup grade is C.");
  if (bearishMacro) addUnique(reasons, BEARISH_MACRO_GRADE_CAP_REASON);
  if (result.institutionalPositioningStatus === "capped") addUnique(reasons, "Institutional positioning is not supportive.");
  if (result.institutionalPositioningStatus === "vetoed") addUnique(reasons, "Bearish Flow Veto");
  result.layerEvaluations?.filter((item) => (item.layer === "Squeeze Market Structure" || item.layer === "Compression Quality") && item.status === "Bearish")
    .forEach((item) => addUnique(reasons, item.detail));
  if (result.layerEvaluations?.some((item) => item.layer === "Options Market Context" && item.status === "Bearish")) addUnique(reasons, "No preferred call contract was found.");
  return reasons;
}

function cachedCompatibilityDecision(grade: ScanResult["grade"], tradeMark: NonNullable<ScanResult["tradeMark"]>): ScanResult["longCallDecision"] {
  if (tradeMark === "Avoid") return "Avoid";
  if (grade === "A") return "Strong Long Call Candidate";
  if (grade === "B") return "Moderate Long Call Candidate";
  return "Watchlist Candidate";
}

function removeWeeklyCachedGradeReasons(reasons: string[]): string[] {
  return reasons.filter((reason) =>
    reason !== WEEKLY_ATR_GRADE_CAP_REASON
    && reason !== RELAXED_WEEKLY_GRADE_CAP_REASON
    && reason !== "Weekly context does not qualify."
    && !reason.toLowerCase().includes("weekly chart qualifies")
    && !reason.toLowerCase().includes("weekly structure")
  );
}

function addUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function hasBearishMacro(result: Pick<ScanResult, "layerEvaluations">): boolean {
  return result.layerEvaluations?.some((item) => item.layer === "Macro Regime" && item.status === "Bearish") ?? false;
}

function hasRelaxedMarketStructure(result: Pick<ScanResult, "layerEvaluations">): boolean {
  return result.layerEvaluations?.some((item) => item.layer === "Squeeze Market Structure" && item.status === "Neutral") ?? false;
}

function hasMissingCachedDailyEmaStack(result: Pick<ScanResult, "squeezeStatusByTimeframe">): boolean {
  const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
  return daily?.positiveEmaStack === false;
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

async function withScanMetadata(input: { mode: ScanMode; results: ScanResult[]; settings: Settings; warnings: string[]; scanDiagnostics?: ScanDiagnostics }): Promise<ScanResponse> {
  const metadata = await readScanMetadata();
  return mergeScanResponseMetadata(input, metadata, Boolean(activeScan));
}

export function mergeScanResponseMetadata(
  input: Pick<ScanResponse, "mode" | "results" | "settings" | "warnings" | "scanDiagnostics">,
  metadata: ScanMetadata,
  isRefreshing: boolean
): ScanResponse {
  return {
    ...metadata,
    ...input,
    scanStatus: isRefreshing ? "running" : metadata.scanStatus,
    isRefreshing
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
  const avgShareVolume = valueWithSource(quote?.averageVolume, "schwab", fmp?.averageVolume, "fmp", undefined, "demo", sources, "avgShareVolume");
  const avgDollarVolume20d = valueWithSource(quote?.avgDollarVolume, "schwab", undefined, "fmp", undefined, "demo", sources, "avgDollarVolume20d");
  const lastEarningsDate = valueWithSource(quote?.lastEarningsDate, "schwab", undefined, "fmp", demo?.lastEarningsDate, "demo", sources, "lastEarningsDate");
  const nextEarningsDate = valueWithSource(fmp?.nextEarningsDate, "fmp", undefined, "schwab", demo?.nextEarningsDate, "demo", sources, "nextEarningsDate");
  const sector = valueWithSource(undefined, "schwab", fmp?.sector, "fmp", demo?.sector, "demo", sources, "sector");
  return {
    symbol,
    beta,
    marketCap,
    avgShareVolume,
    avgDollarVolume20d,
    lastEarningsDate,
    nextEarningsDate,
    sector,
    sources
  };
}

export function withCandleLiquidityFallback(fundamentals: Fundamentals, candles: Candle[]): Fundamentals {
  const recent = candles.slice(-20);
  if (!recent.length) return fundamentals;
  const sources = { ...(fundamentals.sources ?? {}) };
  const avgShareVolume = fundamentals.avgShareVolume ?? averageCandleVolume(recent);
  const avgDollarVolume20d = fundamentals.avgDollarVolume20d
    ?? average(recent.map((candle) => candle.volume * candle.close));
  if (fundamentals.avgShareVolume === undefined) sources.avgShareVolume = "history";
  if (fundamentals.avgDollarVolume20d === undefined) sources.avgDollarVolume20d = "history";
  return {
    ...fundamentals,
    avgShareVolume,
    avgDollarVolume20d,
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
  if (source === "history") return "price history";
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

function formatShares(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M shares";
  if (value >= 1_000) return Math.round(value / 1_000) + "K shares";
  return Math.round(value) + " shares";
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageCandleVolume(candles: Candle[]): number {
  return average(candles.slice(-20).map((candle) => candle.volume));
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
    "skipped because ETF average dollar volume",
    "skipped because average share volume"
  ];
  if (internalMessages.some((message) => warning.includes(message))) return false;
  return !routineSkips.some((message) => warning.includes(message));
}
