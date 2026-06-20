import { describe, expect, it } from "vitest";
import type { Candle, ScanResponse, ScanResult, Settings } from "../shared/types";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { activeSqueezeDotCount } from "./indicators";
import { getCachedResults, getScanMetadata, initDb, replaceScanResults, setScanMetadata } from "./sqlite";
import { __resetScanStateForTest, readCachedScanResponse, readDisplayResults, readSettings, resolveScanSymbols, startScanRefresh } from "./scanner";

describe("scan symbol resolution", () => {
  it("always uses the automatic S&P 500 + Nasdaq 100 universe", async () => {
    const symbols = await resolveScanSymbols();

    expect(symbols.length).toBeGreaterThanOrEqual(defaultUniverseSymbols.length);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("NVDA");
  });
});

describe("background scan refresh", () => {
  it("starts a scan without waiting for completion", async () => withDbRestore(async () => {
    let calls = 0;
    let resolveScan!: (value: ScanResponse) => void;
    const runner = () => {
      calls += 1;
      return new Promise<ScanResponse>((resolve) => {
        resolveScan = resolve;
      });
    };

    const response = await startScanRefresh(runner);

    expect(response.isRefreshing).toBe(true);
    expect(response.scanStatus).toBe("running");
    expect(calls).toBe(1);

    resolveScan(await fakeResponse([]));
    await settleBackgroundScan();
  }));

  it("does not start a duplicate scan while one is running", async () => withDbRestore(async () => {
    let calls = 0;
    let resolveScan!: (value: ScanResponse) => void;
    const runner = () => {
      calls += 1;
      return new Promise<ScanResponse>((resolve) => {
        resolveScan = resolve;
      });
    };

    await startScanRefresh(runner);
    const second = await startScanRefresh(runner);

    expect(calls).toBe(1);
    expect(second.isRefreshing).toBe(true);

    resolveScan(await fakeResponse([]));
    await settleBackgroundScan();
  }));

  it("loads cached results without starting a slow scan", async () => withDbRestore(async () => {
    await replaceScanResults([qualifyingResult("CACHE")]);
    await setScanMetadata({ scanStatus: "complete", lastScanMode: "demo", lastScanFinishedAt: "2026-05-30T12:00:00.000Z" });

    const response = await readCachedScanResponse();

    expect(response.results.map((result) => result.symbol)).toEqual(["CACHE"]);
    expect(response.isRefreshing).toBe(false);
  }));

  it("does not hard-filter cached results by daily or weekly squeeze state", async () => withDbRestore(async () => {
    await replaceScanResults([
      qualifyingResult("NOSQZ", indicator("none"), indicator("none"))
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["NOSQZ"]);
  }));

  it("filters old cached short results from display", async () => withDbRestore(async () => {
    const oldShort: ScanResult = { ...qualifyingResult("OLDPUT"), setupDirection: "short" };
    await replaceScanResults([
      qualifyingResult("LONG"),
      oldShort
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["LONG"]);
  }));

  it("only displays A/B qualified strong or moderate candidates", async () => withDbRestore(async () => {
    const watchlist: ScanResult = { ...qualifyingResult("WATCH"), longCallDecision: "Watchlist Candidate" };
    await replaceScanResults([
      qualifyingResult("QUALIFIED"),
      watchlist
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["QUALIFIED"]);
  }));

  it("normalizes old cached compression diagnostic text without using old scores as dots", async () => withDbRestore(async () => {
    const legacy: ScanResult = {
      ...qualifyingResult("LEGACY"),
      compressionQualityScore: 95,
      maxScore: 100,
      dailySqueezeDotCount: undefined,
      alertMessage: "LEGACY Strong Long Call Candidate at $100.00; compression status Bullish.",
      layerEvaluations: [{
        layer: "Compression Quality",
        status: "Bullish",
        detail: "Daily squeeze is active. Daily compression diagnostic is 95/100."
      }]
    };
    await replaceScanResults([legacy]);

    const [result] = await readDisplayResults();

    expect(result.dailySqueezeDotCount).toBeUndefined();
    expect(result.compressionQualityScore).toBe(95);
    expect(result.layerEvaluations[0].detail).toBe("Run scan for dot count.");
    expect(result.alertMessage).toContain("Daily squeeze dots need a fresh scan");
    expect(result.alertMessage).not.toContain("compression status");
  }));

  it("recomputes daily squeeze dots from old cached candles when available", async () => withDbRestore(async () => {
    const candles = activeDailySqueezeCandles();
    const expectedDots = activeSqueezeDotCount(candles);
    const legacy: ScanResult = {
      ...qualifyingResult("DOTS"),
      candles,
      compressionQualityScore: 95,
      maxScore: 100,
      dailySqueezeDotCount: undefined,
      layerEvaluations: [{
        layer: "Compression Quality",
        status: "Bullish",
        detail: "Daily squeeze is active. Daily compression diagnostic is 95/100."
      }]
    };
    await replaceScanResults([legacy]);

    const [result] = await readDisplayResults();

    expect(result.dailySqueezeDotCount).toBe(expectedDots);
    expect(result.compressionQualityScore).toBe(expectedDots);
    expect(result.maxScore).toBe(5);
    expect(result.layerEvaluations[0].detail).toContain(expectedDots + " consecutive active squeeze dots");
  }));

  it("removes stale cached symbols after a completed refresh", async () => withDbRestore(async () => {
    await replaceScanResults([qualifyingResult("STALE")]);
    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["STALE"]);

    await startScanRefresh(() => fakeResponse([]));
    await settleBackgroundScan();

    expect(await readDisplayResults()).toEqual([]);
  }));

  it("saves scan metadata after a completed refresh", async () => withDbRestore(async () => {
    await startScanRefresh(() => fakeResponse([qualifyingResult("META")], ["ok"] ));
    await settleBackgroundScan();

    const metadata = await getScanMetadata();
    expect(metadata.scanStatus).toBe("complete");
    expect(metadata.lastScanStartedAt).toBeTruthy();
    expect(metadata.lastScanFinishedAt).toBeTruthy();
    expect(metadata.nextRefreshAt).toBeTruthy();
    expect(metadata.lastScanWarnings).toEqual(["ok"]);
  }));
});

async function withDbRestore(run: () => Promise<void>) {
  await initDb();
  const cached = await getCachedResults() as Array<{ symbol: string }>;
  const metadata = await getScanMetadata();
  try {
    await __resetScanStateForTest();
    await run();
  } finally {
    await __resetScanStateForTest();
    await replaceScanResults(cached);
    await setScanMetadata(metadata);
  }
}

async function settleBackgroundScan() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function fakeResponse(results: ScanResult[], warnings: string[] = []): Promise<ScanResponse> {
  return {
    mode: "demo",
    results,
    settings: await readSettings() as Settings,
    warnings,
    scanStatus: "idle"
  };
}

function qualifyingResult(symbol: string, daily = indicator("low"), weekly = indicator("mid")): ScanResult {
  return {
    symbol,
    dataSource: "demo",
    price: 100,
    beta: 1,
    marketCap: 10_000_000_000,
    avgDollarVolume20d: 1_000_000_000,
    optionable: true,
    passesUniverse: true,
    grade: "A",
    longCallDecision: "Strong Long Call Candidate",
    setupQuality: "High",
    entryRecommendationType: "High Conviction Compression Entry",
    score: 95,
    maxScore: 100,
    setupDirection: "long",
    indicators: daily,
    weeklyIndicators: weekly,
    lowerTimeframes: undefined,
    squeezeStatusByTimeframe: [
      { timeframe: "30m", squeezeState: "low", bias: "bullish", priceAboveEmaStack: true, positiveEmaStack: true, withinOneAtrOfEma21: true, compressionStatus: "Bullish", detail: "30m bullish." },
      { timeframe: "1h", squeezeState: "low", bias: "bullish", priceAboveEmaStack: true, positiveEmaStack: true, withinOneAtrOfEma21: true, compressionStatus: "Bullish", detail: "1h bullish." },
      { timeframe: "4h", squeezeState: "low", bias: "bullish", priceAboveEmaStack: true, positiveEmaStack: true, withinOneAtrOfEma21: true, compressionStatus: "Bullish", detail: "4h bullish." },
      { timeframe: "daily", squeezeState: daily.squeezeState, bias: "bullish", priceAboveEmaStack: true, positiveEmaStack: true, withinOneAtrOfEma21: true, compressionStatus: "Bullish", detail: "Daily bullish." },
      { timeframe: "weekly", squeezeState: weekly.squeezeState, bias: "bullish", priceAboveEmaStack: true, positiveEmaStack: true, withinOneAtrOfEma21: true, compressionStatus: "Bullish", detail: "Weekly bullish." }
    ],
    weeklyContextSummary: "Weekly chart supports the bullish thesis.",
    compressionQualityScore: 95,
    compressionQualityStatus: "Bullish",
    setupScore: 88,
    setupScoreStatus: "Bullish",
    institutionalFactors: [],
    multiTimeframeAlignmentSummary: "All selected timeframes are bullish.",
    relativeStrengthSummary: "Outperforming SPY and QQQ.",
    institutionalContextSummary: "Institutional filters passed.",
    macroRegimeSummary: "SPY and QQQ bullish.",
    layerEvaluations: [],
    recommendedDte: "45 DTE swing",
    recommendedDelta: "0.55",
    suggestedEntryArea: "$99.00 to $101.00",
    invalidationLevel: "Daily close below 34/55 EMA zone.",
    stockStopPrice: 95,
    target1: 105,
    target2: 110,
    reasonsSupportingTrade: ["Compression active."],
    reasonsAgainstTrade: [],
    alertMessage: symbol + " compression candidate.",
    journalRecord: symbol + " | Strong Long Call Candidate",
    rules: [],
    suggestedOptions: [],
    candles: [],
    lastUpdated: "2026-05-30T12:00:00.000Z",
    warnings: []
  };
}

function indicator(squeezeState: "none" | "low" | "mid" | "released") {
  return {
    ema8: 103,
    ema21: 100,
    ema34: 98,
    ema55: 96,
    ema89: 94,
    atr14: 2,
    atrContracting: true,
    bbUpper: 101,
    bbLower: 99,
    bbWidth: 2,
    bbContracting: true,
    kcLowUpper: 102,
    kcLowLower: 98,
    kcMidUpper: 103,
    kcMidLower: 97,
    kcHighUpper: 104,
    kcHighLower: 96,
    momentum: 1,
    momentumImproving: true,
    candleRangeContracting: true,
    squeezeState
  };
}

function activeDailySqueezeCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 180; index += 1) {
    const close = index < 140 ? 100 + index * 0.35 : 149 + Math.sin(index / 2) * 0.08;
    const range = index < 140 ? 1.5 : 2.6;
    candles.push({
      date: "2026-04-" + String(index + 1).padStart(2, "0"),
      open: close - 0.05,
      high: close + range,
      low: close - range,
      close,
      volume: 25_000_000
    });
  }
  return candles;
}
