import { describe, expect, it } from "vitest";
import type { Fundamentals, Settings } from "../shared/types";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { resolveScanSymbols } from "./scanner";

function settings(scanMode: Settings["scanMode"], symbols: string[] = []): Settings {
  return {
    scanMode,
    symbols,
    minPrice: 20,
    minBeta: 0.75,
    minMarketCap: 2_000_000_000,
    minAvgDollarVolume: 600_000_000,
    brokerBaseUrl: "",
    brokerCallbackUrl: "",
    hasBrokerCredentials: false,
    useDemoDataWhenMissingApi: true,
    defaultUniverseName: "S&P 500 + Nasdaq 100",
    defaultUniverseCount: defaultUniverseSymbols.length,
    importedUniverseCount: 0
  };
}

describe("scan symbol resolution", () => {
  it("uses the bundled default universe in auto mode", () => {
    const symbols = resolveScanSymbols(settings("auto"), new Map());

    expect(symbols.length).toBe(defaultUniverseSymbols.length);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("NVDA");
  });

  it("uses imported CSV symbols in imported mode", () => {
    const fundamentals = new Map<string, Fundamentals>([
      ["TOSAAA", { symbol: "TOSAAA" }],
      ["TOSBBB", { symbol: "TOSBBB" }]
    ]);

    expect(resolveScanSymbols(settings("imported"), fundamentals)).toEqual(["TOSAAA", "TOSBBB"]);
  });

  it("uses manual symbols in watchlist mode", () => {
    expect(resolveScanSymbols(settings("watchlist", ["MSFT", "AMD"]), new Map())).toEqual(["MSFT", "AMD"]);
  });
});
