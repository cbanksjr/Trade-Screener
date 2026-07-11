import { describe, expect, it } from "vitest";
import type { Candle, ScanDiagnostics, ScanResponse, ScanResult, Settings } from "../shared/types";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { activeSqueezeDotCount } from "./indicators";
import { getCachedResults, getScanMetadata, getSetting, getWatchlistEntries, initDb, removeWatchlistEntry, replaceScanResults, setScanMetadata, setSetting, upsertWatchlistEntry } from "./sqlite";
import { defaultEtfSymbols, parseEtfSymbols } from "./etfUniverse";
import { __clearLivePriceCacheForTest, __resetScanStateForTest, addToWatchlist, mergeFundamentals, mergeScanResponseMetadata, overlayLiveQuotePrices, priceMatchesCandles, readCachedScanResponse, readDisplayResults, readSettings, readWatchlist, recordUniverseWarning, removeFromWatchlist, resolveScanSymbols, SettingsValidationError, startScanRefresh, withCandleLiquidityFallback, writeSettings } from "./scanner";
import type { SchwabQuote } from "./schwab";
import {
  BEARISH_MACRO_GRADE_CAP_REASON,
  EXTENDED_ENTRY_GRADE_CAP_REASON,
  RELAXED_TREND_GRADE_CAP_REASON,
  WEEKLY_ATR_GRADE_CAP_REASON
} from "./scoring";

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

  it("can disable demo fundamental fallback for live scans", () => {
    const fundamentals = mergeFundamentals("AAPL", {
      symbol: "AAPL",
      price: 210
    }, undefined, { allowDemoFallback: false });

    expect(fundamentals.beta).toBeUndefined();
    expect(fundamentals.marketCap).toBeUndefined();
    expect(fundamentals.sources?.beta).toBeUndefined();
    expect(fundamentals.sources?.marketCap).toBeUndefined();
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
  it("defaults volume liquidity thresholds", async () => withDbRestore(async () => {
    await setSetting("settings", {});

    const settings = await readSettings();

    expect(settings.minAvgDollarVolume).toBe(300_000_000);
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

  it("rejects invalid numeric settings before they are stored", async () => withDbRestore(async () => {
    await expect(writeSettings({ minPrice: -1 })).rejects.toBeInstanceOf(SettingsValidationError);

    const settings = await readSettings();
    expect(settings.minPrice).toBe(20);
  }));

  it("rejects malformed ETF setting payloads", async () => withDbRestore(async () => {
    await expect(writeSettings({ etfSymbols: "SPY,QQQ" as unknown as string[] })).rejects.toBeInstanceOf(SettingsValidationError);
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

  it("deduplicates simultaneous refresh triggers before scan metadata is persisted", async () => withDbRestore(async () => {
    let calls = 0;
    let resolveScan!: (value: ScanResponse) => void;
    const runner = () => {
      calls += 1;
      return new Promise<ScanResponse>((resolve) => {
        resolveScan = resolve;
      });
    };

    const [first, second] = await Promise.all([startScanRefresh(runner), startScanRefresh(runner)]);

    expect(calls).toBe(1);
    expect(first.isRefreshing).toBe(true);
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

  it("appends a universe-refresh warning without clobbering existing scan metadata", async () => withDbRestore(async () => {
    await setScanMetadata({ scanStatus: "complete", lastScanMode: "demo", lastScanWarnings: ["Existing warning."] });

    await recordUniverseWarning("Default universe refresh failed: network error.");

    const metadata = await getScanMetadata();
    expect(metadata.scanStatus).toBe("complete");
    expect(metadata.lastScanMode).toBe("demo");
    expect(metadata.lastScanWarnings).toEqual(["Existing warning.", "Default universe refresh failed: network error."]);
  }));

  it("filters cached results when the Daily squeeze is inactive", async () => withDbRestore(async () => {
    await replaceScanResults([
      qualifyingResult("NOSQZ", indicator("none"), indicator("none"))
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual([]);
  }));

  it("caps a cached A-band setup score to grade B when Sector Strength data is missing", async () => withDbRestore(async () => {
    const missingSector: ScanResult = {
      ...qualifyingResult("NOSECTORCACHE"),
      setupScore: 92,
      institutionalFactors: [
        { name: "Sector Strength", status: "Insufficient Data", contribution: 5, detail: "Sector unavailable; A grade capped." }
      ]
    };
    await replaceScanResults([missingSector]);

    const [result] = await readDisplayResults();

    expect(result.grade).toBe("B");
    expect(result.gradeCapReasons).toContain("Sector Strength unavailable.");
  }));

  it("filters old cached short results from display", async () => withDbRestore(async () => {
    const oldShort: ScanResult = { ...qualifyingResult("OLDPUT"), setupDirection: "short" };
    await replaceScanResults([
      qualifyingResult("LONG"),
      oldShort
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["LONG"]);
  }));

  it("filters cached candidates whose Daily Squeeze histogram is not above zero", async () => withDbRestore(async () => {
    const negativeHistogram: ScanResult = {
      ...qualifyingResult("NEGHIST"),
      indicators: { ...indicator("low"), momentum: -1, momentumImproving: true }
    };
    await replaceScanResults([
      qualifyingResult("POSHIST"),
      negativeHistogram
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["POSHIST"]);
  }));

  it("filters cached candidates with fewer than 2 active Daily squeeze dots", async () => withDbRestore(async () => {
    const insufficientDots: ScanResult = {
      ...qualifyingResult("ONEDOT"),
      dailySqueezeDotCount: 1,
      squeezeMaturityMode: "insufficient",
      layerEvaluations: [{
        layer: "Compression Quality",
        status: "Bearish",
        detail: "At least 2 consecutive active daily squeeze dots are required; current count is 1."
      }]
    };
    await replaceScanResults([
      qualifyingResult("TWODOTS"),
      insufficientDots
    ]);

    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["TWODOTS"]);
  }));

  it("keeps bearish-macro cached candidates visible as B setups still marked Take", async () => withDbRestore(async () => {
    const macroCaution: ScanResult = {
      ...qualifyingResult("MACROCAUTION"),
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate",
      layerEvaluations: [{
        layer: "Macro Regime",
        status: "Bearish",
        detail: "SPY or QQQ daily EMA structure is bearish."
      }]
    };
    await replaceScanResults([macroCaution]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("MACROCAUTION");
    expect(result.grade).toBe("B");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.tradeMarkReasons).not.toContain(BEARISH_MACRO_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).toContain(BEARISH_MACRO_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  }));

  it("treats cached FMP Institutional Edge as informational only", async () => withDbRestore(async () => {
    const staleEdgeAvoid: ScanResult = {
      ...qualifyingResult("FMPINFO"),
      setupScore: 95,
      institutionalEdgeStatus: "Bearish",
      tradeMarkReasons: ["Institutional Edge is bearish."],
      tradeMark: "Avoid",
      longCallDecision: "Avoid"
    };
    await replaceScanResults([staleEdgeAvoid]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("FMPINFO");
    expect(result.grade).toBe("A");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.tradeMarkReasons).not.toContain("Institutional Edge is bearish.");
    expect(result.institutionalEdgeStatus).toBe("Bearish");
  }));

  it("removes legacy QuantData promotion from cached results and restores the technical grade", async () => withDbRestore(async () => {
    const promoted: ScanResult = {
      ...qualifyingResult("PROMOTED"),
      setupScore: 88,
      gradeCapReasons: ["Setup score below 90.", BEARISH_MACRO_GRADE_CAP_REASON],
      layerEvaluations: [{
        layer: "Macro Regime",
        status: "Bearish",
        detail: "SPY or QQQ daily EMA structure is bearish."
      }],
      gradeBeforeQuantData: "B",
      finalGrade: "A",
      institutionalPromotionApplied: true
    };
    await replaceScanResults([promoted]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("PROMOTED");
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain(BEARISH_MACRO_GRADE_CAP_REASON);
    expect(result.institutionalPromotionApplied).toBe(false);
  }));

  it("does not promote a cached result on reload when no QuantData promotion was recorded", async () => withDbRestore(async () => {
    const notPromoted: ScanResult = {
      ...qualifyingResult("NOTPROMOTED"),
      setupScore: 88
    };
    await replaceScanResults([notPromoted]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("NOTPROMOTED");
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
  }));

  it("displays valid A/B candidates regardless of legacy decision and weekly structure", async () => withDbRestore(async () => {
    const watchlist: ScanResult = { ...qualifyingResult("WATCH"), longCallDecision: "Watchlist Candidate" };
    const cGrade: ScanResult = { ...qualifyingResult("CGRADE"), setupScore: 69, grade: "C" };
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

    const results = await readDisplayResults();
    expect(results.map((result) => result.symbol).sort()).toEqual(["QUALIFIED", "WATCH", "WEEKLYNEUTRAL"]);
    expect(results.find((result) => result.symbol === "WEEKLYNEUTRAL")?.grade).toBe("B");
    expect(results.find((result) => result.symbol === "WEEKLYNEUTRAL")?.longCallDecision).toBe("Moderate Long Call Candidate");
  }));

  it("keeps ATR-only weekly cached candidates visible without capping them", async () => withDbRestore(async () => {
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
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).not.toContain(WEEKLY_ATR_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  }));

  it("does not add the missing Daily EMA-stack reason to cached neutral market structure when Daily stack is present", async () => withDbRestore(async () => {
    const weeklyCap: ScanResult = {
      ...qualifyingResult("CACHEDWEEKLY"),
      weeklyQualificationMode: "ema21-atr",
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate",
      gradeCapReasons: [RELAXED_TREND_GRADE_CAP_REASON],
      layerEvaluations: [{
        layer: "Squeeze Market Structure",
        status: "Neutral",
        detail: "Weekly qualification is ATR-only."
      }]
    };
    await replaceScanResults([weeklyCap]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("CACHEDWEEKLY");
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).not.toContain(WEEKLY_ATR_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  }));

  it("keeps the missing Daily EMA-stack reason for cached neutral market structure when Daily stack is absent", async () => withDbRestore(async () => {
    const missingDailyStack: ScanResult = {
      ...qualifyingResult("CACHEDDAILY"),
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate",
      squeezeStatusByTimeframe: qualifyingResult("CACHEDDAILY").squeezeStatusByTimeframe.map((item) => item.timeframe === "daily" ? { ...item, positiveEmaStack: false } : item),
      layerEvaluations: [{
        layer: "Squeeze Market Structure",
        status: "Neutral",
        detail: "Daily fast trend qualifies without the full EMA stack."
      }]
    };
    await replaceScanResults([missingDailyStack]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("CACHEDDAILY");
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).toContain(RELAXED_TREND_GRADE_CAP_REASON);
  }));

  it("keeps extended-entry cached candidates visible without a weekly-style cap", async () => withDbRestore(async () => {
    const extendedEntry: ScanResult = {
      ...qualifyingResult("EXTENDEDENTRY"),
      dailyEntryQualificationMode: "extended",
      squeezeMaturityMode: "mature",
      setupScore: 95,
      grade: "A",
      longCallDecision: "Strong Long Call Candidate"
    };
    await replaceScanResults([extendedEntry]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("EXTENDEDENTRY");
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).toContain(EXTENDED_ENTRY_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  }));

  it("keeps developing-squeeze cached candidates visible with setup-grade explanation", async () => withDbRestore(async () => {
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
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Daily squeeze has 2-4 active dots; developing compression contributes fewer setup points.");
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
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
      price: candles[candles.length - 1].close,
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

  it("drops a cached result whose header price no longer matches its candle scale", async () => withDbRestore(async () => {
    const candles = activeDailySqueezeCandles();
    const lastClose = candles[candles.length - 1].close;
    const mismatched: ScanResult = { ...qualifyingResult("BADSCALE"), candles, price: lastClose * 0.6 };
    const consistent: ScanResult = { ...qualifyingResult("GOODSCALE"), candles, price: lastClose };
    await replaceScanResults([mismatched, consistent]);

    const symbols = (await readDisplayResults()).map((result) => result.symbol);

    expect(symbols).toContain("GOODSCALE");
    expect(symbols).not.toContain("BADSCALE");
  }));

  it("removes stale cached symbols after a completed refresh", async () => withDbRestore(async () => {
    await replaceScanResults([qualifyingResult("STALE")]);
    expect((await readDisplayResults()).map((result) => result.symbol)).toEqual(["STALE"]);

    await startScanRefresh(() => fakeResponse([]));
    await settleBackgroundScan();

    expect(await readDisplayResults()).toEqual([]);
  }));

  it("keeps a five-dot squeeze visible even when score, momentum, entry, and compression context say Avoid", async () => withDbRestore(async () => {
    const fiveDot: ScanResult = {
      ...qualifyingResult("FIVEDOT"),
      setupScore: 55,
      grade: "C",
      dailySqueezeDotCount: 5,
      squeezeMaturityMode: "mature",
      dailyEntryQualificationMode: "none",
      indicators: { ...qualifyingResult("FIVEDOT").indicators, momentum: -1, momentumImproving: false },
      layerEvaluations: [{
        layer: "Compression Quality",
        status: "Bearish",
        detail: "Secondary contraction context is weak."
      }]
    };
    await replaceScanResults([fiveDot]);

    const [result] = await readDisplayResults();

    expect(result.symbol).toBe("FIVEDOT");
    expect(result.grade).toBe("C");
    expect(result.tradeMark).toBe("Avoid");
    expect(result.squeezeLifecycleStatus).toBe("ready");
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
      minAvgDollarVolume: 300_000_000,
      skipped: {
        stockLiquidity: 1
      }
    });
  }));

  it("marks a provider-wide scan failure and preserves the previous result cache", async () => withDbRestore(async () => {
    await replaceScanResults([qualifyingResult("PRESERVED")]);
    const diagnostics = fakeDiagnostics({ scannedSymbols: 100, qualifiedResults: 0, quoteMissing: 90 });

    await startScanRefresh(() => fakeResponse([], ["provider failed"], diagnostics, [], []));
    await settleBackgroundScan();

    expect((await readDisplayResults()).map((result) => result.symbol)).toContain("PRESERVED");
    const metadata = await getScanMetadata();
    expect(metadata.scanStatus).toBe("failed");
    expect(metadata.lastScanFailedAt).toBeTruthy();
    expect(metadata.lastScanWarnings?.[0]).toContain("Previous results and watchlist entries were preserved");
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
      minAvgDollarVolume: 300_000_000,
      skipped: {
        stockLiquidity: 42,
        options: 118
      }
    });
  }));

  it("keeps fresh scan diagnostics when merging existing scan metadata", async () => {
    const stale = fakeDiagnostics({ scannedSymbols: 10, qualifiedResults: 0, stockLiquidity: 2 });
    const fresh = fakeDiagnostics({ scannedSymbols: 603, qualifiedResults: 7, options: 118 });
    const response = mergeScanResponseMetadata({
      mode: "live",
      results: [],
      settings: await readSettings(),
      warnings: [],
      scanDiagnostics: fresh
    }, {
      scanStatus: "complete",
      scanDiagnostics: stale
    }, true);

    expect(response.scanStatus).toBe("running");
    expect(response.scanDiagnostics).toEqual(fresh);
  });
});

describe("watchlist manual add", () => {
  it("does not automatically add a scanned symbol marked Take to the watchlist", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("TAKEME"), tradeMark: "Take" as const };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();

    const watchlist = await readWatchlist();
    expect(watchlist.map((entry) => entry.symbol)).not.toContain("TAKEME");
  }));

  it("adds a scanned symbol to the watchlist when requested manually", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("TAKEME"), tradeMark: "Take" as const };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("TAKEME");

    const watchlist = await readWatchlist();
    expect(watchlist.map((entry) => entry.symbol)).toContain("TAKEME");
  }));

  it("throws when adding a symbol that is not in the current scan results", async () => withDbRestore(async () => {
    await startScanRefresh(() => fakeResponse([]));
    await settleBackgroundScan();

    await expect(addToWatchlist("NOTFOUND")).rejects.toThrow();
  }));

  it("removes a watchlisted symbol only after a later scan confirms the squeeze fired", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("STICKY"), tradeMark: "Take" as const };
    const fired = releasedResult(take);

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("STICKY");
    await startScanRefresh(() => fakeResponse([], [], undefined, ["STICKY"], [fired]));
    await settleBackgroundScan();

    const watchlist = await readWatchlist();
    expect(watchlist.map((entry) => entry.symbol)).not.toContain("STICKY");
  }));

  it("keeps a watchlisted symbol when a later scan could not evaluate it (data gap)", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("GAPPY"), tradeMark: "Take" as const };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("GAPPY");
    await startScanRefresh(() => fakeResponse([]));
    await settleBackgroundScan();

    const watchlist = await readWatchlist();
    expect(watchlist.map((entry) => entry.symbol)).toContain("GAPPY");
  }));

  it("keeps and updates a watchlisted symbol when a later scan marks it Avoid", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("FLIPS"), tradeMark: "Take" as const };
    const avoid = { ...qualifyingResult("FLIPS"), tradeMark: "Avoid" as const, tradeMarkReasons: ["Bearish macro."] };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("FLIPS");
    await startScanRefresh(() => fakeResponse([avoid]));
    await settleBackgroundScan();

    const watchlist = await readWatchlist();
    const entry = watchlist.find((item) => item.symbol === "FLIPS");
    expect(entry?.result.tradeMark).toBe("Avoid");
    expect(entry?.result.tradeMarkReasons).toContain("Bearish macro.");
  }));

  it("refreshes a watchlisted symbol's stored result after a later scan", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("REFRESH"), tradeMark: "Take" as const, price: 100 };
    const updated = { ...qualifyingResult("REFRESH"), tradeMark: "Take" as const, price: 101 };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("REFRESH");
    await startScanRefresh(() => fakeResponse([updated]));
    await settleBackgroundScan();

    const watchlist = await readWatchlist();
    const entry = watchlist.find((item) => item.symbol === "REFRESH");
    expect(entry?.result.price).toBe(101);
  }));

  it("removes a symbol from the watchlist on request", async () => withDbRestore(async () => {
    const take = { ...qualifyingResult("DROPME"), tradeMark: "Take" as const };

    await startScanRefresh(() => fakeResponse([take]));
    await settleBackgroundScan();
    await addToWatchlist("DROPME");
    expect((await readWatchlist()).map((entry) => entry.symbol)).toContain("DROPME");

    await removeFromWatchlist("DROPME");

    expect((await readWatchlist()).map((entry) => entry.symbol)).not.toContain("DROPME");
  }));
});

async function withDbRestore(run: () => Promise<void>) {
  await initDb();
  const cached = await getCachedResults() as Array<{ symbol: string }>;
  const metadata = await getScanMetadata();
  const settings = await getSetting<Partial<Settings>>("settings", {});
  const watchlist = await getWatchlistEntries();
  try {
    await __resetScanStateForTest();
    await run();
  } finally {
    await __resetScanStateForTest();
    await replaceScanResults(cached);
    await setScanMetadata(metadata);
    await setSetting("settings", settings);
    for (const entry of await getWatchlistEntries()) {
      await removeWatchlistEntry(entry.symbol);
    }
    for (const entry of watchlist) {
      await upsertWatchlistEntry(entry.symbol, entry.payload);
    }
  }
}

async function settleBackgroundScan() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("live price overlay", () => {
  const quote = (symbol: string, price: number): SchwabQuote => ({ symbol, price });

  it("replaces the frozen scan-time price with the fresh live quote", async () => {
    __clearLivePriceCacheForTest();
    const results = [{ ...qualifyingResult("AAPL"), price: 100 }];
    const overlaid = await overlayLiveQuotePrices(results, {
      isLive: async () => true,
      fetchQuotesFor: async (symbols) => new Map(symbols.map((s) => [s, quote(s, 142.27)])),
      now: () => 1_000
    });
    expect(overlaid[0].price).toBe(142.27);
    // Setup levels are untouched — only the live price changes.
    expect(overlaid[0].target1).toBe(qualifyingResult("AAPL").target1);
  });

  it("is a no-op when live Schwab is unavailable", async () => {
    __clearLivePriceCacheForTest();
    let fetched = false;
    const results = [{ ...qualifyingResult("AAPL"), price: 100 }];
    const overlaid = await overlayLiveQuotePrices(results, {
      isLive: async () => false,
      fetchQuotesFor: async (symbols) => { fetched = true; return new Map(symbols.map((s) => [s, quote(s, 999)])); },
      now: () => 1_000
    });
    expect(fetched).toBe(false);
    expect(overlaid[0].price).toBe(100);
  });

  it("reuses the cached quote within the TTL window and re-quotes after it lapses", async () => {
    __clearLivePriceCacheForTest();
    let calls = 0;
    const results = [{ ...qualifyingResult("AAPL"), price: 100 }];
    const deps = (price: number, now: number) => ({
      isLive: async () => true,
      fetchQuotesFor: async (symbols: string[]) => { calls += 1; return new Map(symbols.map((s) => [s, quote(s, price)])); },
      now: () => now
    });

    const first = await overlayLiveQuotePrices(results, deps(142.27, 0));
    expect(first[0].price).toBe(142.27);
    expect(calls).toBe(1);

    // Within the 60s TTL: cache is reused, no second fetch, price unchanged.
    const second = await overlayLiveQuotePrices(results, deps(150, 30_000));
    expect(second[0].price).toBe(142.27);
    expect(calls).toBe(1);

    // After the TTL lapses: re-quote and pick up the new price.
    const third = await overlayLiveQuotePrices(results, deps(150, 61_000));
    expect(third[0].price).toBe(150);
    expect(calls).toBe(2);
  });

  it("keeps the scan-time price when the live quote diverges too far from the cached candles", async () => {
    __clearLivePriceCacheForTest();
    const base = { ...qualifyingResult("AAPL"), price: 100, candles: [candleAt(100)] };
    const divergedQuote = 150;
    const results = [base];
    const overlaid = await overlayLiveQuotePrices(results, {
      isLive: async () => true,
      fetchQuotesFor: async (symbols) => new Map(symbols.map((s) => [s, quote(s, divergedQuote)])),
      now: () => 1_000
    });
    // The overlaid price would fail priceMatchesCandles, so the frozen
    // scan-time price stays until a fresh scan replaces the candles.
    expect(overlaid[0].price).toBe(base.price);
  });
});

async function fakeResponse(results: ScanResult[], warnings: string[] = [], scanDiagnostics?: ScanDiagnostics, evaluatedSymbols?: string[], evaluatedResults: ScanResult[] = results): Promise<ScanResponse> {
  return {
    mode: "demo",
    results,
    settings: await readSettings() as Settings,
    warnings,
    scanDiagnostics,
    evaluatedSymbols,
    evaluatedResults,
    scanStatus: "idle"
  };
}

function releasedResult(result: ScanResult): ScanResult {
  return {
    ...result,
    dailySqueezeDotCount: 0,
    squeezeMaturityMode: "insufficient",
    squeezeLifecycleStatus: undefined,
    indicators: { ...result.indicators, squeezeState: "released" },
    squeezeStatusByTimeframe: result.squeezeStatusByTimeframe.map((item) => item.timeframe === "daily"
      ? { ...item, squeezeState: "released", compressionStatus: "Bearish" }
      : item)
  };
}

function fakeDiagnostics(input: { scannedSymbols: number; qualifiedResults: number; quoteMissing?: number; stockLiquidity?: number; options?: number }): ScanDiagnostics {
  return {
    scannedSymbols: input.scannedSymbols,
    qualifiedResults: input.qualifiedResults,
    minAvgDollarVolume: 300_000_000,
    skipped: {
      quoteMissing: input.quoteMissing ?? 0,
      price: 0,
      stockLiquidity: input.stockLiquidity ?? 0,
      marketCap: 0,
      candleHistory: 0,
      priceCandleMismatch: 0,
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
    invalidationLevel: "Daily close below the 55/89 EMA zone.",
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

function candleAt(close: number): Candle {
  return { date: "2026-07-09", open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 };
}

describe("priceMatchesCandles", () => {
  it("rejects a live quote price stapled to demo/stale candles on a different scale", () => {
    const result = { ...qualifyingResult("ABNB"), price: 148.04, candles: [candleAt(240), candleAt(245.3)] };
    expect(priceMatchesCandles(result)).toBe(false);
  });

  it("accepts a price equal to the last candle close", () => {
    const result = { ...qualifyingResult("ABNB"), price: 245.3, candles: [candleAt(240), candleAt(245.3)] };
    expect(priceMatchesCandles(result)).toBe(true);
  });

  it("tolerates a small intraday gap between the live quote and the last daily close", () => {
    const result = { ...qualifyingResult("ABNB"), price: 152, candles: [candleAt(148), candleAt(150)] };
    expect(priceMatchesCandles(result)).toBe(true);
  });

  it("does not reject a result with no candles (nothing to compare against)", () => {
    const result = { ...qualifyingResult("ABNB"), price: 148, candles: [] };
    expect(priceMatchesCandles(result)).toBe(true);
  });
});
