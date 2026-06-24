import { describe, expect, it } from "vitest";
import type { Candle, ScanDiagnostics, ScanResponse, ScanResult, Settings } from "../shared/types";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { activeSqueezeDotCount } from "./indicators";
import { getCachedResults, getScanMetadata, getSetting, initDb, replaceScanResults, setScanMetadata, setSetting } from "./sqlite";
import { defaultEtfSymbols, parseEtfSymbols } from "./etfUniverse";
import { __resetScanStateForTest, mergeFundamentals, readCachedScanResponse, readDisplayResults, readSettings, resolveScanSymbols, startScanRefresh, withCandleLiquidityFallback } from "./scanner";

describe("scan symbol resolution", () => {
  it("uses the automatic S&P 500 + Nasdaq 100 universe plus default ETFs", async () => withDbRestore(async () => {
    await setSetting("settings", {});

    const symbols = await resolveScanSymbols();

    expect(symbols.length).toBeGreaterThanOrEqual(defaultUniverseSymbols.length);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("NVDA");
    expect(symbols).toContain("SPY");
    expect(symbols).toContain("QQQ");
    expect(symbols).toContain("SMH");
  }));

  it("normalizes ETF symbols from configuration-style input", () => {
    expect(parseEtfSymbols("spy, qqq, SMH, bad-symbol!, spy")).toEqual(["QQQ", "SMH", "SPY"]);
  });
});

describe("fundamental provider merge", () => {
  it("keeps Schwab values ahead of FMP fallback values while FMP supplies next earnings", () => {
    const fundamentals = mergeFundamentals("KEEP", {
      symbol: "KEEP",
      price: 50,
      beta: 1.1,
      marketCap: 10_000_000_000,
      averageVolume: 1_200_000,
      lastEarningsDate: "2026-08-01"
    }, {
      symbol: "KEEP",
      beta: 1.8,
      marketCap: 20_000_000_000,
      averageVolume: 2_400_000,
      sector: "Information Technology",
      nextEarningsDate: "2026-09-01"
    });

    expect(fundamentals.beta).toBe(1.1);
    expect(fundamentals.marketCap).toBe(10_000_000_000);
    expect(fundamentals.avgShareVolume).toBe(1_200_000);
    expect(fundamentals.lastEarningsDate).toBe("2026-08-01");
    expect(fundamentals.nextEarningsDate).toBe("2026-09-01");
    expect(fundamentals.sector).toBe("Information Technology");
    expect(fundamentals.sources).toMatchObject({
      beta: "schwab",
      marketCap: "schwab",
      avgShareVolume: "schwab",
      sector: "fmp",
      lastEarningsDate: "schwab",
      nextEarningsDate: "fmp"
    });
  });

  it("does not use Schwab last earnings as next earnings when FMP is unavailable", () => {
    const fundamentals = mergeFundamentals("EARN", {
      symbol: "EARN",
      price: 50,
      lastEarningsDate: "2026-08-01"
    }, {
      symbol: "EARN"
    });

    expect(fundamentals.lastEarningsDate).toBe("2026-08-01");
    expect(fundamentals.nextEarningsDate).toBeUndefined();
    expect(fundamentals.sources).toMatchObject({
      lastEarningsDate: "schwab"
    });
  });

  it("fills Schwab gaps from FMP before demo fallback", () => {
    const fundamentals = mergeFundamentals("GAP", {
      symbol: "GAP",
      price: 50
    }, {
      symbol: "GAP",
      beta: 1.3,
      marketCap: 3_000_000_000,
      averageVolume: 850_000,
      sector: "Consumer Discretionary",
      nextEarningsDate: "2026-10-10"
    });

    expect(fundamentals).toMatchObject({
      beta: 1.3,
      marketCap: 3_000_000_000,
      avgShareVolume: 850_000,
      sector: "Consumer Discretionary",
      nextEarningsDate: "2026-10-10"
    });
    expect(fundamentals.sources).toMatchObject({
      beta: "fmp",
      marketCap: "fmp",
      avgShareVolume: "fmp",
      sector: "fmp",
      nextEarningsDate: "fmp"
    });
  });

  it("keeps existing demo fallback when Schwab and FMP are both missing", () => {
    const fundamentals = mergeFundamentals("AAPL", {
      symbol: "AAPL",
      price: 210
    });

    expect(fundamentals.beta).toBe(1.12);
    expect(fundamentals.marketCap).toBe(3_100_000_000_000);
    expect(fundamentals.sources).toMatchObject({
      beta: "demo",
      marketCap: "demo"
    });
  });

  it("uses recent candle volume after Schwab and FMP omit average volume", () => {
    const fundamentals = mergeFundamentals("HISTORY", {
      symbol: "HISTORY",
      price: 50,
      marketCap: 5_000_000_000
    });
    const candles = Array.from({ length: 25 }, (_, index) => ({
      date: "2026-06-" + String(index + 1).padStart(2, "0"),
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      volume: index < 5 ? 100_000 : 750_000
    }));

    const resolved = withCandleLiquidityFallback(fundamentals, candles);

    expect(resolved.avgShareVolume).toBe(750_000);
    expect(resolved.avgDollarVolume20d).toBe(37_500_000);
    expect(resolved.sources).toMatchObject({
      avgShareVolume: "history",
      avgDollarVolume20d: "history"
    });
  });

  it("keeps FMP average volume ahead of candle-history fallback", () => {
    const fundamentals = mergeFundamentals("FMPVOL", {
      symbol: "FMPVOL",
      price: 50,
      marketCap: 5_000_000_000
    }, {
      symbol: "FMPVOL",
      averageVolume: 850_000
    });
    const candles = Array.from({ length: 20 }, (_, index) => ({
      date: "2026-05-" + String(index + 1).padStart(2, "0"),
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      volume: 750_000
    }));

    const resolved = withCandleLiquidityFallback(fundamentals, candles);

    expect(resolved.avgShareVolume).toBe(850_000);
    expect(resolved.sources?.avgShareVolume).toBe("fmp");
  });
});

describe("settings", () => {
  it("defaults average dollar volume to $300M", async () => withDbRestore(async () => {
    await setSetting("settings", {});

    const settings = await readSettings();

    expect(settings.minAvgDollarVolume).toBe(300_000_000);
    expect(settings.minAvgShareVolume).toBe(600_000);
  }));

  it("migrates the old $600M average dollar volume default to $300M", async () => withDbRestore(async () => {
    await setSetting("settings", { minAvgDollarVolume: 600_000_000 });

    const settings = await readSettings();
    const stored = await getSetting<Partial<Settings>>("settings", {});

    expect(settings.minAvgDollarVolume).toBe(300_000_000);
    expect(stored.minAvgDollarVolume).toBe(300_000_000);
  }));

  it("preserves custom average dollar volume settings", async () => withDbRestore(async () => {
    await setSetting("settings", { minAvgDollarVolume: 450_000_000 });

    const settings = await readSettings();

    expect(settings.minAvgDollarVolume).toBe(450_000_000);
  }));

  it("preserves custom average share volume settings", async () => withDbRestore(async () => {
    await setSetting("settings", { minAvgShareVolume: 900_000 });

    const settings = await readSettings();

    expect(settings.minAvgShareVolume).toBe(900_000);
  }));

  it("allows settings to override the ETF scan list", async () => withDbRestore(async () => {
    await setSetting("settings", { etfSymbols: ["spy", "qqq", "bad-symbol!", "SPY"] });

    const settings = await readSettings();
    const symbols = await resolveScanSymbols(settings);

    expect(settings.etfSymbols).toEqual(["QQQ", "SPY"]);
    expect(symbols).toContain("SPY");
    expect(symbols).toContain("QQQ");
    expect(symbols).not.toContain("SMH");
  }));

  it("uses the curated ETF list when settings do not override it", async () => withDbRestore(async () => {
    await setSetting("settings", {});

    const settings = await readSettings();

    expect(settings.etfSymbols).toEqual(defaultEtfSymbols);
  }));
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

  it("only displays A/B qualified strong or moderate candidates with qualifying weekly context", async () => withDbRestore(async () => {
    const watchlist: ScanResult = { ...qualifyingResult("WATCH"), longCallDecision: "Watchlist Candidate" };
    const cGrade: ScanResult = { ...qualifyingResult("CGRADE"), setupScore: 79, grade: "C" };
    const nonBullishWeekly: ScanResult = {
      ...qualifyingResult("WEEKLYNEUTRAL"),
      weeklyQualificationMode: "none",
      squeezeStatusByTimeframe: qualifyingResult("WEEKLYNEUTRAL").squeezeStatusByTimeframe.map((item) => item.timeframe === "weekly" ? { ...item, bias: "neutral" } : item)
    };
    await replaceScanResults([
      qualifyingResult("QUALIFIED"),
      watchlist,
      cGrade,
      nonBullishWeekly
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["QUALIFIED"]);
  }));

  it("keeps ATR-only weekly cached candidates visible but caps them at B", async () => withDbRestore(async () => {
    const atrOnly: ScanResult = {
      ...qualifyingResult("WEEKLYATR"),
      weeklyQualificationMode: "ema21-atr",
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate"
    };
    await replaceScanResults([atrOnly]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("WEEKLYATR");
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
  }));

  it("keeps broad-entry cached candidates visible but caps them at B", async () => withDbRestore(async () => {
    const broadEntry: ScanResult = {
      ...qualifyingResult("BROADENTRY"),
      dailyEntryQualificationMode: "broad",
      squeezeMaturityMode: "mature",
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate"
    };
    await replaceScanResults([broadEntry]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("BROADENTRY");
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Daily price is between the 21 EMA and 8 EMA but outside the stricter buffered A-entry pocket.");
  }));

  it("keeps developing-squeeze cached candidates visible but caps them at B", async () => withDbRestore(async () => {
    const developing: ScanResult = {
      ...qualifyingResult("DEVELOPING"),
      dailyEntryQualificationMode: "strict",
      dailySqueezeDotCount: 4,
      squeezeMaturityMode: "developing",
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate"
    };
    await replaceScanResults([developing]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("DEVELOPING");
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Daily squeeze has 3-4 active dots; developing compression is capped at B.");
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
    const diagnostics = fakeDiagnostics({ scannedSymbols: 2, qualifiedResults: 1, stockLiquidity: 1 });
    await startScanRefresh(() => fakeResponse([qualifyingResult("META")], ["ok"], diagnostics));
    await settleBackgroundScan();

    const metadata = await getScanMetadata();
    expect(metadata.scanStatus).toBe("complete");
    expect(metadata.lastScanStartedAt).toBeTruthy();
    expect(metadata.lastScanFinishedAt).toBeTruthy();
    expect(metadata.nextRefreshAt).toBeTruthy();
    expect(metadata.lastScanWarnings).toEqual(["ok"]);
    expect(metadata.scanDiagnostics).toMatchObject({
      scannedSymbols: 2,
      qualifiedResults: 1,
      minAvgShareVolume: 600_000,
      minAvgDollarVolume: 300_000_000,
      skipped: {
        stockLiquidity: 1
      }
    });
  }));

  it("returns completed scan diagnostics with cached results", async () => withDbRestore(async () => {
    await replaceScanResults([qualifyingResult("DIAG")]);
    await setScanMetadata({
      scanStatus: "complete",
      lastScanMode: "live",
      lastScanFinishedAt: "2026-05-30T12:00:00.000Z",
      scanDiagnostics: fakeDiagnostics({ scannedSymbols: 603, qualifiedResults: 19, stockLiquidity: 42, options: 118 })
    });

    const response = await readCachedScanResponse();

    expect(response.scanDiagnostics).toMatchObject({
      scannedSymbols: 603,
      qualifiedResults: 19,
      minAvgShareVolume: 600_000,
      minAvgDollarVolume: 300_000_000,
      skipped: {
        stockLiquidity: 42,
        options: 118
      }
    });
  }));
});

async function withDbRestore(run: () => Promise<void>) {
  await initDb();
  const cached = await getCachedResults() as Array<{ symbol: string }>;
  const metadata = await getScanMetadata();
  const settings = await getSetting<Partial<Settings>>("settings", {});
  try {
    await __resetScanStateForTest();
    await run();
  } finally {
    await __resetScanStateForTest();
    await replaceScanResults(cached);
    await setScanMetadata(metadata);
    await setSetting("settings", settings);
  }
}

async function settleBackgroundScan() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function fakeResponse(results: ScanResult[], warnings: string[] = [], scanDiagnostics?: ScanDiagnostics): Promise<ScanResponse> {
  return {
    mode: "demo",
    results,
    settings: await readSettings() as Settings,
    warnings,
    scanDiagnostics,
    scanStatus: "idle"
  };
}

function fakeDiagnostics(input: { scannedSymbols: number; qualifiedResults: number; stockLiquidity?: number; options?: number }): ScanDiagnostics {
  return {
    scannedSymbols: input.scannedSymbols,
    qualifiedResults: input.qualifiedResults,
    minAvgShareVolume: 600_000,
    minAvgDollarVolume: 300_000_000,
    skipped: {
      quoteMissing: 0,
      price: 0,
      stockLiquidity: input.stockLiquidity ?? 0,
      marketCap: 0,
      candleHistory: 0,
      options: input.options ?? 0,
      spreadLiquidity: 0,
      marketStructure: 0,
      catalyst: 0,
      sectorDataCap: 0,
      finalDisplayFilter: 0,
      other: 0
    }
  };
}

function qualifyingResult(symbol: string, daily = indicator("low"), weekly = indicator("mid")): ScanResult {
  return {
    symbol,
    assetType: "stock",
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
    invalidationLevel: "Daily close below 50/100 EMA zone.",
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
    ema50: 97,
    ema55: 96,
    ema89: 94,
    ema100: 93,
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
