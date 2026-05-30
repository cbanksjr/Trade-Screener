import { describe, expect, it } from "vitest";
import { demoCandles, demoOptions } from "./demoData";
import { latestIndicators } from "./indicators";
import { gradeSetup } from "./scoring";

describe("indicator calculations", () => {
  it("calculates the core swing indicators from candle history", () => {
    const indicators = latestIndicators(demoCandles("AAPL"));
    expect(indicators.ema21).toBeGreaterThan(0);
    expect(indicators.ema50).toBeGreaterThan(0);
    expect(indicators.atr14).toBeGreaterThan(0);
    expect(["none", "low", "mid", "high", "released"]).toContain(indicators.squeezeState);
  });
});

describe("transparent grading", () => {
  it("returns a grade, score breakdown, and option suggestions", () => {
    const candles = demoCandles("NVDA");
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "NVDA",
      candles,
      fundamentals: {
        symbol: "NVDA",
        beta: 1.7,
        marketCap: 2_900_000_000_000,
        avgDollarVolume20d: 35_000_000_000
      },
      optionable: true,
      options: demoOptions("NVDA", price)
    });
    expect(result.rules.length).toBeGreaterThan(5);
    expect(result.score).toBeLessThanOrEqual(result.maxScore);
    expect(result.suggestedOptions.length).toBeGreaterThan(0);
  });

  it("flags stocks that fail Schwab-driven universe filters", () => {
    const candles = demoCandles("LOWBETA");
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "LOWBETA",
      candles,
      fundamentals: {
        symbol: "LOWBETA",
        beta: 0.4,
        marketCap: 500_000_000,
        avgDollarVolume20d: 10_000_000
      },
      optionable: false,
      options: demoOptions("LOWBETA", price)
    });
    expect(result.passesUniverse).toBe(false);
    expect(result.rules.find((rule) => rule.id === "optionable")?.passed).toBe(false);
    expect(result.rules.find((rule) => rule.id === "dollar-volume")?.passed).toBe(false);
  });
});
