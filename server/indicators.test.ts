import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/types";
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


  it("identifies bearish short setups when price is below the 21 EMA within -1 ATR", () => {
    const candles = bearishCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "BEAR",
      candles,
      fundamentals: {
        symbol: "BEAR",
        beta: 1.2,
        marketCap: 20_000_000_000,
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("BEAR", price)
    });

    expect(result.setupDirection).toBe("short");
    expect(result.rules.find((rule) => rule.id === "ema-stack")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.id === "price-side")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.id === "near-ema")?.passed).toBe(true);
    expect(result.suggestedOptions.every((contract) => contract.optionType === "put")).toBe(true);
  });

  it("requires beta and market cap when strict fundamentals are enabled", () => {
    const candles = demoCandles("MISS");
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "MISS",
      candles,
      fundamentals: {
        symbol: "MISS",
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("MISS", price),
      strictFundamentals: true
    });

    expect(result.passesUniverse).toBe(false);
    expect(result.rules.find((rule) => rule.id === "beta")?.passed).toBe(false);
    expect(result.rules.find((rule) => rule.id === "market-cap")?.passed).toBe(false);
  });

  it("allows bundled-universe candidates when Schwab omits beta and market cap", () => {
    const candles = demoCandles("AAPL");
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "AAPL",
      candles,
      fundamentals: {
        symbol: "AAPL",
        avgDollarVolume20d: 8_500_000_000
      },
      optionable: true,
      options: demoOptions("AAPL", price),
      strictFundamentals: false
    });

    expect(result.rules.find((rule) => rule.id === "beta")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.id === "market-cap")?.passed).toBe(true);
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

function bearishCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 180; index += 1) {
    const close = 220 - index * 0.35 + Math.sin(index / 6) * 1.2;
    candles.push({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: close + 0.4,
      high: close + 2.4,
      low: close - 2.4,
      close,
      volume: 25_000_000
    });
  }
  return candles;
}
