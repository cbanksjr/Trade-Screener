import { describe, expect, it } from "vitest";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { resolveScanSymbols } from "./scanner";

describe("scan symbol resolution", () => {
  it("always uses the automatic S&P 500 + Nasdaq 100 universe", () => {
    const symbols = resolveScanSymbols();

    expect(symbols.length).toBeGreaterThanOrEqual(defaultUniverseSymbols.length);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("NVDA");
  });
});
