import type { AssetType, Candle, CandidateListResponse, CandidateSummary, FundamentalFieldSources, Fundamentals, IndicatorSnapshot, ScanDiagnosticCounts, ScanDiagnostics, ScanMetadata, ScanMode, ScanResponse, ScanResult, Settings, WatchlistEntry } from "../shared/types";
import { AUTO_REFRESH_INTERVAL_MS } from "../shared/refreshSchedule";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { resolveEtfSymbols } from "./etfUniverse";
import { createFmpScanFallback, type FmpFundamentals } from "./fmp";
import { createFmpInstitutionalEdgeScanProvider } from "./fmpInstitutionalEdge";
import { activeSqueezeDotCount, latestIndicators, MIN_CANDLES_REQUIRED } from "./indicators";
import { computeMacroRegimeContext, type MacroRegimeContext } from "./macroRegime";
import { createQuantDataPositioningScanProvider } from "./quantData";
import {
  A_SETUP_SCORE_THRESHOLD,
  BEARISH_MACRO_GRADE_CAP_REASON,
  B_SETUP_SCORE_THRESHOLD,
  DEVELOPING_SQUEEZE_GRADE_CAP_REASON,
  EXTENDED_ENTRY_GRADE_CAP_REASON,
  RELAXED_TREND_GRADE_CAP_REASON,
  RELAXED_WEEKLY_GRADE_CAP_REASON,
  WEEKLY_ATR_GRADE_CAP_REASON,
  applyInstitutionalEdge,
  applyInstitutionalPositioning,
  applyMacroRegimeModifier,
  defaultSettings,
  gradeFromSetupScore,
  gradeSetup,
  isSqueezeActive,
  resolveDailyEntryQualificationMode,
  resolveSqueezeMaturityMode,
  resolveWeeklyQualificationMode
} from "./scoring";
import { fetchCallOptions, fetchHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getCachedResults, getScanMetadata, getSetting, getWatchlistEntries, removeWatchlistEntry, replaceScanResults, setScanMetadata, setSetting, upsertWatchlistEntry } from "./sqlite";
import { aggregateDailyCandlesToWeeks } from "./timeframes";
import { getDefaultUniverseSectorMap, getDefaultUniverseStatus, getDefaultUniverseSymbols, MIN_REFRESHED_SYMBOLS } from "./universe";

const SCAN_CONCURRENCY = 4;
const MEMORY_LOG_INTERVAL = 50;
const MAX_STORED_SCAN_WARNINGS = 50;
const CATASTROPHIC_FAILURE_RATIO = 0.8;
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

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

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
  const validated = validateSettingsInput(input);
  const next: Settings = {
    ...current,
    minPrice: validated.minPrice ?? current.minPrice,
    minBeta: validated.minBeta ?? current.minBeta,
    minMarketCap: validated.minMarketCap ?? current.minMarketCap,
    minAvgDollarVolume: validated.minAvgDollarVolume ?? current.minAvgDollarVolume,
    useDemoDataWhenMissingApi: validated.useDemoDataWhenMissingApi ?? current.useDemoDataWhenMissingApi,
    etfSymbols: validated.etfSymbols ?? current.etfSymbols
  };
  await setSetting("settings", next);
  return readSettings();
}

function validateSettingsInput(input: Partial<Settings>): Partial<Settings> {
  const output: Partial<Settings> = {};
  if ("minPrice" in input) output.minPrice = positiveNumber(input.minPrice, "minPrice", { minExclusive: 0, maxInclusive: 10_000 });
  if ("minBeta" in input) output.minBeta = positiveNumber(input.minBeta, "minBeta", { minInclusive: 0, maxInclusive: 10 });
  if ("minMarketCap" in input) output.minMarketCap = positiveNumber(input.minMarketCap, "minMarketCap", { minInclusive: 0, maxInclusive: 10_000_000_000_000 });
  if ("minAvgDollarVolume" in input) output.minAvgDollarVolume = positiveNumber(input.minAvgDollarVolume, "minAvgDollarVolume", { minInclusive: 0, maxInclusive: 100_000_000_000 });
  if ("useDemoDataWhenMissingApi" in input) {
    if (typeof input.useDemoDataWhenMissingApi !== "boolean") throw new SettingsValidationError("useDemoDataWhenMissingApi must be a boolean.");
    output.useDemoDataWhenMissingApi = input.useDemoDataWhenMissingApi;
  }
  if ("etfSymbols" in input) {
    if (Array.isArray(input.etfSymbols) && input.etfSymbols.every((symbol) => typeof symbol === "string")) {
      output.etfSymbols = resolveEtfSymbols(input.etfSymbols);
    } else {
      throw new SettingsValidationError("etfSymbols must be an array of ticker strings.");
    }
  }
  return output;
}

function positiveNumber(
  value: unknown,
  field: string,
  bounds: { minExclusive?: number; minInclusive?: number; maxInclusive: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SettingsValidationError(field + " must be a finite number.");
  if (bounds.minExclusive !== undefined && value <= bounds.minExclusive) throw new SettingsValidationError(field + " must be greater than " + bounds.minExclusive + ".");
  if (bounds.minInclusive !== undefined && value < bounds.minInclusive) throw new SettingsValidationError(field + " must be at least " + bounds.minInclusive + ".");
  if (value > bounds.maxInclusive) throw new SettingsValidationError(field + " must be at most " + bounds.maxInclusive + ".");
  return value;
}

export async function runScan(): Promise<ScanResponse> {
  return startScanRefresh();
}

export async function startScanRefresh(scanRunner: () => Promise<ScanResponse> = runFullScan): Promise<ScanResponse> {
  if (!activeScan) {
    const startedAt = new Date().toISOString();
    const initialized = readScanMetadata().then((metadata) => setScanMetadata({
      ...metadata,
      scanStatus: "running",
      lastScanStartedAt: startedAt,
      isRefreshing: true
    }));
    // Claim the in-process lock before awaiting persistence so simultaneous
    // browser and cron triggers cannot start duplicate full-universe scans.
    activeScan = initialized
      .then(() => executeScanRefresh(scanRunner, startedAt))
      .catch(() => undefined)
      .finally(() => {
        activeScan = null;
      });
    await initialized;
  }
  return readCachedScanResponse();
}

export async function readCachedScanResponse(): Promise<ScanResponse> {
  const metadata = await readScanMetadata();
  return {
    mode: metadata.lastScanMode ?? "demo",
    results: await overlayLiveQuotePrices(await readDisplayResults()),
    settings: await readSettings(),
    warnings: (metadata.lastScanWarnings ?? []).filter(shouldShowWarning),
    ...metadata,
    scanStatus: activeScan ? "running" : metadata.scanStatus,
    isRefreshing: Boolean(activeScan)
  };
}

export async function readScanStatusResponse(): Promise<Omit<ScanResponse, "results" | "settings">> {
  const metadata = await readScanMetadata();
  return {
    mode: metadata.lastScanMode ?? "demo",
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
    lastScanFailedAt: stored.lastScanFailedAt,
    lastScanMode: stored.lastScanMode,
    lastScanWarnings: (stored.lastScanWarnings ?? []).filter(shouldShowWarning),
    scanDiagnostics: stored.scanDiagnostics,
    nextRefreshAt: stored.nextRefreshAt,
    isRefreshing: Boolean(activeScan)
  };
}

export async function recordUniverseWarning(message: string): Promise<void> {
  const metadata = await getScanMetadata();
  await setScanMetadata({
    ...metadata,
    lastScanWarnings: [...new Set([...(metadata.lastScanWarnings ?? []), message])]
  });
}

export async function runFullScan(): Promise<ScanResponse> {
  const scanRanAt = new Date();
  const settings = await readSettings();
  const previousResults = await readDisplayResults();
  const previousBySymbol = new Map(previousResults.map((result) => [result.symbol, result]));
  const watchlistEntries = await readWatchlist();
  const watchlistBySymbol = new Map(watchlistEntries.map((entry) => [entry.symbol, entry]));
  const results: ScanResult[] = [];
  // Only watchlisted evaluations need to survive until persistence. Keeping a
  // full ScanResult for every index constituent caused full scans to approach
  // Render's heap limit even though most symbols were filtered out.
  const watchlistEvaluatedResults: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  let processedSymbols = 0;
  const etfSymbols = settings.etfSymbols;
  const etfSymbolSet = new Set(etfSymbols);
  let symbolsToScan = await resolveScanSymbols(settings);
  logScanMemory("start", { universeSize: symbolsToScan.length });
  const stockSymbolsToScan = symbolsToScan.filter((symbol) => !etfSymbolSet.has(symbol));
  const diagnostics = createScanDiagnostics(symbolsToScan.length, settings.minAvgDollarVolume);
  if (symbolsToScan.length < MIN_REFRESHED_SYMBOLS) {
    scanWarnings.add("Scan universe contains only " + symbolsToScan.length + " symbols; expected at least " + MIN_REFRESHED_SYMBOLS + ".");
  }
  const canUseLiveSchwab = hasSchwabCredentials() && await hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();
  const benchmarks = canUseLiveSchwab
    ? await loadBenchmarks(scanWarnings)
    : { spyCandles: demoCandles("SPY"), qqqCandles: demoCandles("QQQ"), vixLevel: undefined };
  const macroRegime: MacroRegimeContext = computeMacroRegimeContext({
    spyCandles: benchmarks.spyCandles,
    qqqCandles: benchmarks.qqqCandles,
    vixLevel: benchmarks.vixLevel
  });
  macroRegime.warnings.forEach((warning) => scanWarnings.add(warning));
  const sectorBySymbol = await getDefaultUniverseSectorMap();
  const sectorHistories = canUseLiveSchwab ? await loadSectorHistories(scanWarnings) : new Map<string, Candle[]>();
  const fmp = canUseLiveSchwab ? await createFmpScanFallback() : undefined;
  const fmpInstitutionalEdge = canUseLiveSchwab ? await createFmpInstitutionalEdgeScanProvider() : undefined;
  const quantDataPositioning = canUseLiveSchwab ? await createQuantDataPositioningScanProvider() : undefined;
  if (quantDataPositioning) {
    // Universe-wide, once-per-scan prioritization (not a scoring factor): order per-symbol
    // QuantData spend toward names showing real same-day institutional flow first.
    const ranking = await quantDataPositioning.rankSymbols(symbolsToScan);
    if (ranking.usedLive) usedLive = true;
    ranking.warnings.forEach((warning) => scanWarnings.add(warning));
    symbolsToScan = ranking.symbols;
  }
  const fmpEarnings = fmp && stockSymbolsToScan.length ? await fmp.earningsCalendar(stockSymbolsToScan) : undefined;
  const earningsBySymbol = fmpEarnings?.earningsBySymbol ?? new Map<string, string>();
  fmpEarnings?.warnings.forEach((warning) => scanWarnings.add(warning));
  if (fmpEarnings?.usedLive) usedLive = true;

  if (!canUseLiveSchwab) {
    scanWarnings.add("Automatic screening needs Schwab connected so it can scan the full S&P 500 + Nasdaq 100 + selected ETF universe with live market data.");
  }

  const evaluatedSymbols = new Set<string>();
  await consumeLimit(symbolsToScan, SCAN_CONCURRENCY, async (symbol) => {
    const sector = sectorBySymbol[symbol];
    const assetType: AssetType = etfSymbolSet.has(symbol) ? "etf" : "stock";
    const outcome = await scanSymbol({
      symbol,
      assetType,
      settings,
      canUseLiveSchwab,
      quote: quoteMap.get(symbol),
      spyCandles: benchmarks.spyCandles,
      qqqCandles: benchmarks.qqqCandles,
      macroRegime,
      sector,
      sectorCandles: sector ? sectorHistories.get(sector) : undefined,
      sectorHistories,
      nextEarningsDate: earningsBySymbol.get(symbol),
      fmp,
      scanRanAt
    });
    outcome.warnings.forEach((warning) => scanWarnings.add(warning));
    if (outcome.skipReason) diagnostics.skipped[outcome.skipReason] += 1;
    if (outcome.result) {
      evaluatedSymbols.add(outcome.result.symbol);
      const previous = previousBySymbol.get(outcome.result.symbol);
      const watchlistEntry = watchlistBySymbol.get(outcome.result.symbol);
      const wasTracked = Boolean(previous || watchlistEntry);
      const keepTrackedUntilFire = wasTracked && isActiveTrackedSqueeze(outcome.result);
      const newlyDiscovered = shouldIncludeResult(outcome.result);
      let result = outcome.result;
      if (newlyDiscovered || keepTrackedUntilFire) result = applyMacroRegimeModifier(result, macroRegime);
      if (fmpInstitutionalEdge) {
        if (newlyDiscovered || keepTrackedUntilFire) {
          const edge = await fmpInstitutionalEdge.enrich(result.symbol, result.assetType, result.price);
          if (edge.usedLive) usedLive = true;
          result = applyInstitutionalEdge(result, edge.edge);
        }
      }
      if (quantDataPositioning && (newlyDiscovered || keepTrackedUntilFire)) {
        const compressionActive = result.layerEvaluations.some((item) => item.layer === "Compression Quality" && item.status !== "Bearish");
        const positioning = await quantDataPositioning.enrich(result.symbol, result.price, {
          compressionActive,
          nearestExpirationDate: result.recommendedOptionContract?.expirationDate,
          daysToNearestExpiration: result.recommendedOptionContract?.dte
        });
        if (positioning.usedLive) usedLive = true;
        positioning.warnings.forEach((warning) => scanWarnings.add(warning));
        result = applyInstitutionalPositioning(result, positioning.positioning);
      }
      if (newlyDiscovered || keepTrackedUntilFire) {
        result = withSqueezeLifecycle(result, previous?.firstDetectedAt ?? watchlistEntry?.result.firstDetectedAt ?? previous?.lastUpdated ?? watchlistEntry?.addedAt ?? scanRanAt.toISOString());
      }
      if (watchlistEntry) watchlistEvaluatedResults.push(result);
      if (!priceMatchesCandles(result)) diagnostics.skipped.priceCandleMismatch += 1;
      else if (shouldIncludeResult(result) || keepTrackedUntilFire) results.push(result);
      else diagnostics.skipped[classifyFilteredResult(result)] += 1;
    } else if (!outcome.skipReason) diagnostics.skipped.other += 1;
    if (outcome.usedLive) usedLive = true;
    if (outcome.usedDemo) usedDemo = true;
    processedSymbols += 1;
    if (processedSymbols % MEMORY_LOG_INTERVAL === 0) {
      logScanMemory("progress", { processedSymbols, universeSize: symbolsToScan.length, retainedResults: results.length });
    }
  });

  const resultSymbols = new Set(results.map((result) => result.symbol));
  const scannedSymbols = new Set(symbolsToScan);
  for (const previous of previousResults) {
    if (!scannedSymbols.has(previous.symbol) || evaluatedSymbols.has(previous.symbol) || resultSymbols.has(previous.symbol)) continue;
    // Never re-emit a stale payload whose header price no longer matches its
    // candle scale (e.g. a legacy live-quote-over-demo-candles row); its chart
    // and trade plan would be meaningless.
    if (!priceMatchesCandles(previous)) {
      diagnostics.skipped.priceCandleMismatch += 1;
      continue;
    }
    // A provider/data gap cannot prove that a tracked squeeze fired. Keep the
    // last known active payload until a later scan evaluates its squeeze state.
    results.push(previous);
    resultSymbols.add(previous.symbol);
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
  logScanMemory("complete", {
    processedSymbols,
    universeSize: symbolsToScan.length,
    retainedResults: results.length,
    watchlistEvaluations: watchlistEvaluatedResults.length,
    durationMs: Date.now() - scanRanAt.getTime()
  });
  return withScanMetadata({
    mode: usedLive && usedDemo ? "mixed" : usedLive ? "live" : "demo",
    results: results.sort(sortByDecision),
    settings,
    warnings: [...scanWarnings].filter(shouldShowWarning),
    scanDiagnostics: diagnostics,
    evaluatedSymbols: [...evaluatedSymbols],
    evaluatedResults: watchlistEvaluatedResults
  });
}

export async function resolveScanSymbols(inputSettings?: Settings): Promise<string[]> {
  const settings = inputSettings ?? await readSettings();
  return mergeSymbols(await getDefaultUniverseSymbols(), settings.etfSymbols);
}

export async function readDisplayResults(): Promise<ScanResult[]> {
  return (await getCachedResults())
    .map((result) => normalizeCachedResult(result as ScanResult))
    .filter((result): result is ScanResult => priceMatchesCandles(result) && shouldIncludeResult(result));
}

export async function readCandidateListResponse(): Promise<CandidateListResponse> {
  const response = await readCachedScanResponse();
  return {
    ...response,
    // Mature C setups remain persisted and tracked, but the default scanner shortlist
    // is intentionally limited to actionable technical grades.
    results: response.results.filter((result) => result.grade !== "C").map(candidateSummary)
  };
}

export async function readDisplayResult(symbol: string): Promise<ScanResult | undefined> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const match = (await readDisplayResults()).find((result) => result.symbol === normalizedSymbol);
  if (!match) return undefined;
  return (await overlayLiveQuotePrices([match]))[0];
}

function candidateSummary(result: ScanResult): CandidateSummary {
  const { symbol, companyName, assetType, price, passesUniverse, grade, tradeMark, setupScore, dailySqueezeDotCount, lastUpdated } = result;
  return { symbol, companyName, assetType, price, passesUniverse, grade, tradeMark, setupScore, dailySqueezeDotCount, lastUpdated };
}

export async function readWatchlist(): Promise<WatchlistEntry[]> {
  const entries = await getWatchlistEntries();
  const results = await overlayLiveQuotePrices(
    entries.map((entry) => normalizeCachedResult(entry.payload as ScanResult))
  );
  return entries.map((entry, index) => ({
    symbol: entry.symbol,
    addedAt: entry.addedAt,
    result: results[index]
  }));
}

// `ScanResult.price` is frozen when a scan runs and persisted, but a full scan only
// happens ~once a weekday plus opportunistic refreshes. Between scans the stored price
// goes stale relative to the broker's live last price. This overlay re-quotes the
// displayed symbols on the read/refresh path so the number shown tracks the current
// Schwab quote. Setup levels (entry/target/stop) are intentionally left untouched — they
// are the levels the setup earned, not the live price.
type LivePriceCacheEntry = { price: number; at: number };
const livePriceCache = new Map<string, LivePriceCacheEntry>();

export function __clearLivePriceCacheForTest(): void {
  livePriceCache.clear();
}

async function isLiveSchwabAvailable(): Promise<boolean> {
  return hasSchwabCredentials() && (await hasSchwabTokens());
}

export async function overlayLiveQuotePrices(
  results: ScanResult[],
  deps: {
    isLive?: () => Promise<boolean>;
    fetchQuotesFor?: (symbols: string[]) => Promise<Map<string, SchwabQuote>>;
    now?: () => number;
  } = {}
): Promise<ScanResult[]> {
  if (!results.length) return results;
  const isLive = deps.isLive ?? isLiveSchwabAvailable;
  if (!(await isLive())) return results;

  const fetchQuotesFor = deps.fetchQuotesFor ?? fetchQuotes;
  const now = deps.now ?? Date.now;
  const ttlMs = Math.max(0, config.livePriceOverlayTtlSeconds * 1000);
  const currentTime = now();

  const symbols = [...new Set(results.map((result) => result.symbol))];
  const staleSymbols = symbols.filter((symbol) => {
    const entry = livePriceCache.get(symbol);
    return !entry || currentTime - entry.at >= ttlMs;
  });

  if (staleSymbols.length) {
    try {
      const quotes = await fetchQuotesFor(staleSymbols);
      for (const symbol of staleSymbols) {
        const price = quotes.get(symbol)?.price;
        if (typeof price === "number" && price > 0) {
          livePriceCache.set(symbol, { price, at: currentTime });
        }
      }
    } catch {
      // Leave prices as-is (cached or scan-time) rather than breaking the dashboard.
    }
  }

  return results.map((result) => {
    const entry = livePriceCache.get(result.symbol);
    if (!entry) return result;
    const overlaid = { ...result, price: entry.price };
    // Keep the price/candle scale guard intact between scans: a live quote
    // that has moved beyond what the cached candles can represent would pair
    // a mismatched header price with the chart and trade plan, so keep the
    // scan-time price until the next refresh replaces the candles.
    return priceMatchesCandles(overlaid) ? overlaid : result;
  });
}

export async function removeFromWatchlist(symbol: string): Promise<void> {
  await removeWatchlistEntry(symbol);
}

export async function addToWatchlist(symbol: string): Promise<void> {
  const results = await readDisplayResults();
  const match = results.find((result) => result.symbol === symbol);
  if (!match) throw new Error(`No scan result found for symbol ${symbol}.`);
  await upsertWatchlistEntry(symbol, match);
}

async function syncWatchlistWithLatestResults(evaluatedResults: ScanResult[] = []): Promise<void> {
  const entries = await getWatchlistEntries();
  if (!entries.length) return;
  const resultBySymbol = new Map(evaluatedResults.map((result) => [result.symbol, result]));
  for (const entry of entries) {
    const match = resultBySymbol.get(entry.symbol);
    if (!match) continue;
    if (isActiveTrackedSqueeze(match)) {
      const previous = entry.payload as ScanResult;
      await upsertWatchlistEntry(entry.symbol, withSqueezeLifecycle(match, previous.firstDetectedAt ?? entry.addedAt));
    } else {
      // Only a confirmed squeeze release/end or a manual action removes a saved setup.
      await removeWatchlistEntry(entry.symbol);
    }
  }
}

export async function __resetScanStateForTest() {
  activeScan = null;
  await setScanMetadata({ scanStatus: "idle" });
}

async function executeScanRefresh(scanRunner: () => Promise<ScanResponse>, startedAt: string): Promise<void> {
  try {
    const response = await scanRunner();
    const catastrophicReason = catastrophicScanReason(response);
    if (catastrophicReason) throw new Error(catastrophicReason);
    await replaceScanResults(response.results);
    await syncWatchlistWithLatestResults(response.evaluatedResults);
    const finishedAt = new Date().toISOString();
    await setScanMetadata({
      scanStatus: "complete",
      lastScanStartedAt: startedAt,
      lastScanFinishedAt: finishedAt,
      lastScanFailedAt: undefined,
      lastScanMode: response.mode,
      lastScanWarnings: compactScanWarnings(response.warnings),
      scanDiagnostics: response.scanDiagnostics,
      nextRefreshAt: new Date(new Date(startedAt).getTime() + AUTO_REFRESH_INTERVAL_MS).toISOString(),
      isRefreshing: false
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    logScanMemory("failed", { message: readError(error, "Scan failed.") });
    await setScanMetadata({
      ...await readScanMetadata(),
      scanStatus: "failed",
      lastScanStartedAt: startedAt,
      lastScanFailedAt: finishedAt,
      lastScanWarnings: [readError(error, "Scan failed.")].filter(shouldShowWarning),
      nextRefreshAt: new Date(Date.now() + AUTO_REFRESH_INTERVAL_MS).toISOString(),
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
  macroRegime?: MacroRegimeContext;
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
  const allowDemoFallback = settings.useDemoDataWhenMissingApi && !canUseLiveSchwab;

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
    if (quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
      warnings.push(symbol + ": skipped because average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
      return { warnings, usedLive, usedDemo, skipReason: "stockLiquidity" };
    }

    const earlyFmp = assetType === "stock" ? await input.fmp?.enrich(symbol, {
      beta: assetType === "stock" && quote?.beta === undefined,
      marketCap: assetType === "stock" && quote?.marketCap === undefined,
      averageVolume: assetType === "stock" && quote?.averageVolume === undefined
    }) : undefined;
    earlyFmp?.warnings.forEach((warning) => warnings.push(symbol + ": " + warning));
    if (earlyFmp?.usedLive) usedLive = true;
    let fundamentals = mergeFundamentals(symbol, quote, earlyFmp?.data, { allowDemoFallback });

    if (assetType === "stock" && fundamentals.marketCap !== undefined && fundamentals.sources?.marketCap !== "demo" && fundamentals.marketCap < settings.minMarketCap) {
      warnings.push(symbol + ": skipped because " + sourceLabel(fundamentals.sources?.marketCap) + " market cap is below " + formatMoney(settings.minMarketCap) + ".");
      return { warnings, usedLive, usedDemo, skipReason: "marketCap" };
    }

    let candles = canUseLiveSchwab ? await fetchHistory(symbol) : [];
    if (candles.length >= MIN_CANDLES_REQUIRED) {
      candlesSource = "schwab";
      usedLive = true;
    }
    if (candles.length < MIN_CANDLES_REQUIRED && allowDemoFallback) {
      if (canUseLiveSchwab) warnings.push(symbol + ": Schwab returned fewer than " + MIN_CANDLES_REQUIRED + " historical candles; demo candles were used.");
      candles = demoCandles(symbol);
      candlesSource = "demo";
      usedDemo = true;
    }
    if (candles.length < MIN_CANDLES_REQUIRED) throw new Error("Not enough candle history.");

    const price = quote?.price ?? candles[candles.length - 1].close;
    fundamentals = withCandleLiquidityFallback(fundamentals, candles);
    const liquidityPasses = (fundamentals.avgDollarVolume20d ?? 0) >= settings.minAvgDollarVolume;
    if (!liquidityPasses) {
      warnings.push(symbol + ": skipped because average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
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
      }, { allowDemoFallback });
    }
    if (input.nextEarningsDate && fundamentals.sources?.nextEarningsDate !== "fmp") {
      fundamentals = mergeFundamentals(symbol, quote, {
        ...(earlyFmp?.data ?? { symbol }),
        ...(contextFmp?.data ?? {}),
        nextEarningsDate: input.nextEarningsDate,
        symbol
      }, { allowDemoFallback });
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
        currentVolume: quote?.volume,
        fundamentals: fundamentalData,
        optionable: options.length > 0,
        options,
        weeklyIndicators: weekly.indicators,
        weeklySqueezeWarning: weekly.warning,
        spyCandles: input.spyCandles,
        qqqCandles: input.qqqCandles,
        macroRegime: input.macroRegime,
        sector,
        sectorCandles: sector ? input.sectorHistories?.get(sector) ?? input.sectorCandles : undefined,
        minPrice: settings.minPrice,
        minMarketCap: settings.minMarketCap,
        minBeta: settings.minBeta,
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
        }, { allowDemoFallback });
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
      return { warnings, usedLive, usedDemo, skipReason: message.includes("Not enough candle history") || message.includes("candles are required") ? "candleHistory" : "other" };
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
      macroRegime: input.macroRegime,
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

// A result's header price (result.price, from the live quote) and its chart /
// trade-plan levels (derived from result.candles) must share a scale. A large
// divergence means the candles are stale or demo relative to the quote, so the
// chart and trade plan are meaningless. 15% is far above any intraday
// quote-vs-last-daily-close gap yet far below a demo/stale mismatch (~65%).
const PRICE_CANDLE_MAX_DIVERGENCE = 0.15;
export function priceMatchesCandles(result: ScanResult): boolean {
  const last = result.candles?.[result.candles.length - 1]?.close;
  // With no candle (or price) to compare against, this guard can't prove a
  // scale mismatch, so it doesn't drop the result on that basis — real results
  // always carry candles, so this only spares edge rows a false rejection.
  if (!last || !result.price) return true;
  return Math.abs(result.price - last) / last <= PRICE_CANDLE_MAX_DIVERGENCE;
}

function shouldIncludeResult(result: ScanResult): boolean {
  if (result.setupDirection !== "long" || !isActiveTrackedSqueeze(result)) return false;
  if (result.squeezeLifecycleStatus) return true;
  if (!result.passesUniverse) return false;
  const dotCount = result.dailySqueezeDotCount ?? 0;
  // Five active dots establish a trackable squeeze setup. Momentum, entry
  // location, setup score, and institutional context still determine grade and
  // Take/Avoid, but no longer hide the setup before it fires.
  if (dotCount >= 5) return true;
  return result.indicators.momentum > 0
    && !hasBearishCompression(result)
    && result.dailyEntryQualificationMode !== "none"
    && (result.grade === "A" || result.grade === "B");
}

export function isActiveTrackedSqueeze(result: ScanResult): boolean {
  const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
  if (!isSqueezeActive(daily?.squeezeState === "unavailable" ? undefined : daily?.squeezeState)) return false;
  if (result.squeezeMaturityMode === "insufficient") return false;
  if (typeof result.dailySqueezeDotCount === "number" && result.dailySqueezeDotCount < 2) return false;
  return true;
}

function hasBearishCompression(result: ScanResult): boolean {
  return result.layerEvaluations?.some((item) => item.layer === "Compression Quality" && item.status === "Bearish") ?? false;
}

function withSqueezeLifecycle(result: ScanResult, firstDetectedAt: string): ScanResult {
  const dotCount = result.dailySqueezeDotCount ?? 0;
  return {
    ...result,
    squeezeLifecycleStatus: dotCount >= 5 ? "ready" : "developing",
    firstDetectedAt: result.firstDetectedAt ?? firstDetectedAt
  };
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

function createScanDiagnostics(scannedSymbols: number, minAvgDollarVolume: number): ScanDiagnostics {
  return {
    scannedSymbols,
    qualifiedResults: 0,
    minAvgDollarVolume,
    skipped: {
      quoteMissing: 0,
      price: 0,
      stockLiquidity: 0,
      marketCap: 0,
      candleHistory: 0,
      priceCandleMismatch: 0,
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
  const missingDailyEmaStack = hasMissingCachedDailyEmaStack(result);
  const capA = (result.institutionalFactors ?? []).some(
    (item) => (item.name === "Sector Strength" || item.name === "Catalyst Safety") && item.status === "Insufficient Data"
  );
  const bearishMacro = result.layerEvaluations?.some((item) => item.layer === "Macro Regime" && item.status === "Bearish") ?? false;
  let scoreGrade = gradeFromSetupScore(setupScore);
  if ((capA || bearishMacro) && scoreGrade === "A") scoreGrade = "B";
  const grade = scoreGrade;
  const gradeCapReasons = mergeCachedGradeCapReasons(result, setupScore, dailyEntryQualificationMode, squeezeMaturityMode, missingDailyEmaStack);
  const tradeMarkReasons = cachedTradeMarkReasons(result, grade, setupScore);
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
    squeezeLifecycleStatus: dotCount !== undefined && dotCount >= 2 && isCachedDailySqueezeActive(result)
      ? result.squeezeLifecycleStatus ?? (dotCount >= 5 ? "ready" : "developing")
      : undefined,
    firstDetectedAt: dotCount !== undefined && dotCount >= 2 && isCachedDailySqueezeActive(result)
      ? result.firstDetectedAt ?? result.lastUpdated
      : result.firstDetectedAt,
    tradeMark,
    tradeMarkReasons,
    gradeCapReasons,
    strongLongCallCandidate: longCallDecision === "Strong Long Call Candidate",
    flags: (result.flags ?? []).filter((flag) => flag !== "QuantData Grade Promotion"),
    gradeBeforeQuantData: result.institutionalPositioningStatus ? grade : result.gradeBeforeQuantData,
    finalGrade: result.institutionalPositioningStatus ? grade : result.finalGrade,
    institutionalPromotionApplied: false,
    finalScore: typeof result.finalScore === "number" ? result.finalScore : setupScore,
    macroModifierApplied: typeof result.macroModifierApplied === "number" ? result.macroModifierApplied : 1,
    counterTrend: result.counterTrend ?? false,
    macroRegimeQqq: result.macroRegimeQqq,
    macroRegimeSpy: result.macroRegimeSpy,
    effectiveMacroRegime: result.effectiveMacroRegime,
    alertMessage: normalizeAlertMessage(result, longCallDecision, dotCount),
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
    .filter((reason) => reason !== "Options Market Context is neutral.");
  if (dailyEntryQualificationMode === "extended" && !reasons.includes(EXTENDED_ENTRY_GRADE_CAP_REASON)) reasons.push(EXTENDED_ENTRY_GRADE_CAP_REASON);
  if (squeezeMaturityMode === "developing" && !reasons.includes(DEVELOPING_SQUEEZE_GRADE_CAP_REASON)) reasons.push(DEVELOPING_SQUEEZE_GRADE_CAP_REASON);
  if (hasRelaxedMarketStructure(result) && missingDailyEmaStack && !reasons.includes(RELAXED_TREND_GRADE_CAP_REASON)) reasons.push(RELAXED_TREND_GRADE_CAP_REASON);
  if (result.layerEvaluations?.some((item) => item.layer === "Macro Regime" && item.status === "Bearish") && !reasons.includes(BEARISH_MACRO_GRADE_CAP_REASON)) reasons.push(BEARISH_MACRO_GRADE_CAP_REASON);
  return reasons;
}

function cachedTradeMarkReasons(result: ScanResult, grade: ScanResult["grade"], setupScore: number): string[] {
  const reasons = (result.tradeMarkReasons ?? []).filter((reason) => reason !== "Institutional Edge is bearish.");
  if (grade === "C" || setupScore < B_SETUP_SCORE_THRESHOLD) addUnique(reasons, "Setup grade is C.");
  if (result.institutionalPositioningStatus === "capped") addUnique(reasons, "Institutional positioning is not supportive.");
  if (result.institutionalPositioningStatus === "vetoed") addUnique(reasons, "Bearish Flow Veto");
  removeItem(reasons, BEARISH_MACRO_GRADE_CAP_REASON);
  result.layerEvaluations?.filter((item) => (item.layer === "Squeeze Market Structure" || item.layer === "Compression Quality") && item.status === "Bearish")
    .forEach((item) => addUnique(reasons, item.detail));
  result.layerEvaluations?.filter((item) => item.layer === "Options Market Context" && item.status === "Bearish")
    .forEach((item) => addUnique(reasons, item.detail));
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

function removeItem(items: string[], value: string): void {
  const index = items.indexOf(value);
  if (index >= 0) items.splice(index, 1);
}

function hasRelaxedMarketStructure(result: Pick<ScanResult, "layerEvaluations">): boolean {
  return result.layerEvaluations?.some((item) => item.layer === "Squeeze Market Structure" && item.status === "Neutral") ?? false;
}

function hasMissingCachedDailyEmaStack(result: Pick<ScanResult, "squeezeStatusByTimeframe">): boolean {
  const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
  return daily?.positiveEmaStack === false;
}

function isCachedDailySqueezeActive(result: Pick<ScanResult, "squeezeStatusByTimeframe">): boolean {
  const daily = result.squeezeStatusByTimeframe?.find((item) => item.timeframe === "daily");
  return isSqueezeActive(daily?.squeezeState === "unavailable" ? undefined : daily?.squeezeState);
}

function resolveDailySqueezeDotCount(result: ScanResult): number | undefined {
  if (typeof result.dailySqueezeDotCount === "number") return result.dailySqueezeDotCount;
  if (!result.candles?.length) return undefined;
  try {
    // Cached rows only carry the trailing 120-candle window (scoring.ts), so
    // this recompute is a lower bound for legacy rows whose squeeze predates
    // the window. That is safe: every grading threshold saturates at 5 dots,
    // so only the displayed count can understate, never the behavior.
    return activeSqueezeDotCount(result.candles);
  } catch {
    return undefined;
  }
}

function normalizeAlertMessage(result: ScanResult, decision: ScanResult["longCallDecision"], dotCount: number | undefined): string {
  const dotText = dotCount === undefined ? "Daily squeeze dots need a fresh scan" : dotCount + " active Daily squeeze dots";
  return result.symbol + " " + decision + " at $" + result.price.toFixed(2) + "; " + dotText + ". Watch for controlled consolidation before expansion.";
}

function weeklySqueezeFromDaily(candles: Awaited<ReturnType<typeof fetchHistory>>): { indicators?: ReturnType<typeof latestIndicators>; warning?: string } {
  try {
    return { indicators: latestIndicators(aggregateDailyCandlesToWeeks(candles)) };
  } catch (error) {
    return { warning: readError(error, "Weekly squeeze could not be calculated.") };
  }
}

async function withScanMetadata(input: { mode: ScanMode; results: ScanResult[]; settings: Settings; warnings: string[]; scanDiagnostics?: ScanDiagnostics; evaluatedSymbols?: string[]; evaluatedResults?: ScanResult[] }): Promise<ScanResponse> {
  const metadata = await readScanMetadata();
  return mergeScanResponseMetadata(input, metadata, Boolean(activeScan));
}

export function mergeScanResponseMetadata(
  input: Pick<ScanResponse, "mode" | "results" | "settings" | "warnings" | "scanDiagnostics" | "evaluatedSymbols" | "evaluatedResults">,
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

export function catastrophicScanReason(response: Pick<ScanResponse, "scanDiagnostics">): string | undefined {
  const diagnostics = response.scanDiagnostics;
  if (!diagnostics || diagnostics.scannedSymbols <= 0) return undefined;
  const providerFailures = diagnostics.skipped.quoteMissing + diagnostics.skipped.candleHistory;
  if (providerFailures / diagnostics.scannedSymbols < CATASTROPHIC_FAILURE_RATIO) return undefined;
  return "Scan failed safely: market-data providers could not fully evaluate " + providerFailures + " of " + diagnostics.scannedSymbols + " symbols. Previous results and watchlist entries were preserved.";
}

function compactScanWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_STORED_SCAN_WARNINGS) return warnings;
  const visible = warnings.slice(0, MAX_STORED_SCAN_WARNINGS - 1);
  visible.push((warnings.length - visible.length) + " additional scan warnings were omitted from persisted metadata.");
  return visible;
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

async function loadBenchmarks(warnings: Set<string>): Promise<{ spyCandles?: Awaited<ReturnType<typeof fetchHistory>>; qqqCandles?: Awaited<ReturnType<typeof fetchHistory>>; vixLevel?: number }> {
  const output: { spyCandles?: Awaited<ReturnType<typeof fetchHistory>>; qqqCandles?: Awaited<ReturnType<typeof fetchHistory>>; vixLevel?: number } = {};
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
  try {
    const vixQuote = await fetchQuote("$VIX");
    if (vixQuote?.price !== undefined) output.vixLevel = vixQuote.price;
    else warnings.add("VIX quote returned no price; volatility regime treated as low/neutral for this scan.");
  } catch (error) {
    warnings.add(readError(error, "VIX quote request failed; volatility regime treated as low/neutral for this scan."));
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

export function mergeFundamentals(symbol: string, quote?: SchwabQuote, fmp?: FmpFundamentals, options: { allowDemoFallback?: boolean } = {}): Fundamentals {
  const demo = options.allowDemoFallback === false ? undefined : demoFundamental(symbol);
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

async function consumeLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function logScanMemory(event: "start" | "progress" | "complete" | "failed", details: Record<string, number | string> = {}): void {
  const memory = process.memoryUsage();
  console.info(JSON.stringify({
    event: `scan.${event}`,
    ...details,
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    rssMb: Math.round(memory.rss / 1024 / 1024)
  }));
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
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
    "SELECT value FROM settings",
    "schwabTokens"
  ];
  const routineSkips = [
    "Schwab did not return a quote; skipped.",
    "skipped because Schwab quote price",
    "skipped because average dollar volume is below",
    "market cap is below"
  ];
  if (internalMessages.some((message) => warning.includes(message))) return false;
  return !routineSkips.some((message) => warning.includes(message));
}
