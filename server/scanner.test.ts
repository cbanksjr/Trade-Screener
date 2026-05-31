import { describe, expect, it } from "vitest";
import type { ScanResponse, ScanResult, Settings } from "../shared/types";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { getCachedResults, getScanMetadata, initDb, replaceScanResults, setScanMetadata } from "./sqlite";
import { __resetScanStateForTest, readCachedScanResponse, readDisplayResults, readSettings, resolveScanSymbols, startScanRefresh } from "./scanner";

describe("scan symbol resolution", () => {
  it("always uses the automatic S&P 500 + Nasdaq 100 universe", () => {
    const symbols = resolveScanSymbols();

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

    const response = startScanRefresh(runner);

    expect(response.isRefreshing).toBe(true);
    expect(response.scanStatus).toBe("running");
    expect(calls).toBe(1);

    resolveScan(fakeResponse([]));
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

    startScanRefresh(runner);
    const second = startScanRefresh(runner);

    expect(calls).toBe(1);
    expect(second.isRefreshing).toBe(true);

    resolveScan(fakeResponse([]));
    await settleBackgroundScan();
  }));

  it("loads cached results without starting a slow scan", async () => withDbRestore(async () => {
    replaceScanResults([qualifyingResult("CACHE")]);
    setScanMetadata({ scanStatus: "complete", lastScanMode: "demo", lastScanFinishedAt: "2026-05-30T12:00:00.000Z" });

    const response = readCachedScanResponse();

    expect(response.results.map((result) => result.symbol)).toEqual(["CACHE"]);
    expect(response.isRefreshing).toBe(false);
  }));

  it("does not hard-filter cached results by daily or weekly squeeze state", async () => withDbRestore(async () => {
    replaceScanResults([
      qualifyingResult("NOSQZ", indicator("none"), indicator("none"))
    ]);

    expect(readDisplayResults().map((result) => result.symbol)).toEqual(["NOSQZ"]);
  }));

  it("removes stale cached symbols after a completed refresh", async () => withDbRestore(async () => {
    replaceScanResults([qualifyingResult("STALE")]);
    expect(readDisplayResults().map((result) => result.symbol)).toEqual(["STALE"]);

    startScanRefresh(() => Promise.resolve(fakeResponse([])));
    await settleBackgroundScan();

    expect(readDisplayResults()).toEqual([]);
  }));

  it("saves scan metadata after a completed refresh", async () => withDbRestore(async () => {
    startScanRefresh(() => Promise.resolve(fakeResponse([qualifyingResult("META")], ["ok"] )));
    await settleBackgroundScan();

    const metadata = getScanMetadata();
    expect(metadata.scanStatus).toBe("complete");
    expect(metadata.lastScanStartedAt).toBeTruthy();
    expect(metadata.lastScanFinishedAt).toBeTruthy();
    expect(metadata.nextRefreshAt).toBeTruthy();
    expect(metadata.lastScanWarnings).toEqual(["ok"]);
  }));
});

async function withDbRestore(run: () => Promise<void>) {
  initDb();
  const cached = getCachedResults() as Array<{ symbol: string }>;
  const metadata = getScanMetadata();
  try {
    __resetScanStateForTest();
    await run();
  } finally {
    __resetScanStateForTest();
    replaceScanResults(cached);
    setScanMetadata(metadata);
  }
}

async function settleBackgroundScan() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function fakeResponse(results: ScanResult[], warnings: string[] = []): ScanResponse {
  return {
    mode: "demo",
    results,
    settings: readSettings() as Settings,
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
    score: 95,
    maxScore: 100,
    setupDirection: "long",
    indicators: daily,
    weeklyIndicators: weekly,
    lowerTimeframes: undefined,
    rules: [],
    suggestedOptions: [],
    candles: [],
    lastUpdated: "2026-05-30T12:00:00.000Z",
    warnings: []
  };
}

function indicator(squeezeState: "none" | "low" | "mid" | "released") {
  return {
    ema21: 100,
    ema50: 95,
    atr14: 2,
    bbUpper: 101,
    bbLower: 99,
    kcLowUpper: 102,
    kcLowLower: 98,
    kcMidUpper: 103,
    kcMidLower: 97,
    kcHighUpper: 104,
    kcHighLower: 96,
    momentum: 1,
    squeezeState
  };
}
