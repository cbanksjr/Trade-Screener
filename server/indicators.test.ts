import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/types";
import { demoOptions } from "./demoData";
import { latestIndicators, squeezeState } from "./indicators";
import { gradeSetup, isSqueezeActive } from "./scoring";
import { buildLowerTimeframeConfluence } from "./timeframes";

describe("indicator calculations", () => {
  it("calculates five-EMA compression indicators from candle history", () => {
    const indicators = latestIndicators(bullishCompressionCandles());

    expect(indicators.ema8).toBeGreaterThan(indicators.ema21);
    expect(indicators.ema21).toBeGreaterThan(indicators.ema34);
    expect(indicators.ema34).toBeGreaterThan(indicators.ema55);
    expect(indicators.ema55).toBeGreaterThan(indicators.ema89);
    expect(indicators.atr14).toBeGreaterThan(0);
    expect(typeof indicators.atrContracting).toBe("boolean");
    expect(typeof indicators.bbContracting).toBe("boolean");
    expect(typeof indicators.momentumImproving).toBe("boolean");
  });

  it("classifies Squeeze Pro levels from Bollinger/Keltner envelopes", () => {
    expect(squeezeState(100, 100, 102, 98, 101, 99, 100, 100)).toBe("high");
    expect(squeezeState(100.5, 99.5, 102, 98, 101, 99, 100, 100)).toBe("mid");
    expect(squeezeState(101.5, 98.5, 102, 98, 101, 99, 100, 100)).toBe("low");
    expect(squeezeState(102.5, 97.5, 102, 98, 101, 99, 100, 100)).toBe("released");
  });
});

describe("layer decision engine", () => {
  it("treats only low, mid, and high as active squeeze states", () => {
    expect(isSqueezeActive("low")).toBe(true);
    expect(isSqueezeActive("mid")).toBe(true);
    expect(isSqueezeActive("high")).toBe(true);
    expect(isSqueezeActive("released")).toBe(false);
    expect(isSqueezeActive("none")).toBe(false);
  });

  it("returns A or B grades from new criteria without weighted setup scoring", () => {
    const candles = bullishCompressionCandles();
    const price = candles[candles.length - 1].close;
    const lowerTimeframes = buildLowerTimeframeConfluence(intradayCandles("up", 90));
    const result = gradeSetup({
      symbol: "BULL",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("BULL"),
      optionable: true,
      options: demoOptions("BULL", price),
      lowerTimeframes,
      spyCandles: bullishCompressionCandles(),
      qqqCandles: bullishCompressionCandles()
    });

    expect(["A", "B"]).toContain(result.grade);
    expect(["Strong Long Call Candidate", "Moderate Long Call Candidate", "Watchlist Candidate", "Avoid"]).toContain(result.longCallDecision);
    expect(result.layerEvaluations).toHaveLength(5);
    expect(result.compressionQualityScore).toBeGreaterThanOrEqual(0);
    expect(result.maxScore).toBe(100);
  });

  it("keeps weekly squeeze as bonus context instead of a requirement", () => {
    const candles = bullishCompressionCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "NOWEEKLY",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("NOWEEKLY"),
      optionable: true,
      options: demoOptions("NOWEEKLY", price),
      lowerTimeframes: buildLowerTimeframeConfluence(intradayCandles("up", 90))
    });

    expect(result.weeklyContextSummary).toContain("Weekly context unavailable");
    expect(result.rules.some((rule) => rule.id === "weekly-squeeze")).toBe(false);
  });

  it("marks poor institutional context below qualified quality", () => {
    const candles = bullishCompressionCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "LOWQUAL",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "LOWQUAL",
        beta: 0.4,
        marketCap: 500_000_000,
        avgDollarVolume20d: 10_000_000
      },
      optionable: false,
      options: []
    });

    expect(result.passesUniverse).toBe(false);
    expect(result.longCallDecision).toBe("Avoid");
  });
});

function bullishCompressionCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 180; index += 1) {
    const close = 100 + index * 0.35 + Math.sin(index / 8) * (index > 130 ? 0.35 : 1.1);
    candles.push({
      date: "2026-03-" + String(index + 1).padStart(2, "0"),
      open: close - 0.25,
      high: close + (index > 130 ? 0.7 : 1.4),
      low: close - (index > 130 ? 0.7 : 1.4),
      close,
      volume: 25_000_000
    });
  }
  return candles;
}

function intradayCandles(direction: "up" | "down", days = 90): Candle[] {
  const candles: Candle[] = [];
  const start = Date.UTC(2026, 0, 5, 14, 30);
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < 26; slot += 1) {
      const index = day * 26 + slot;
      const close = direction === "up" ? 100 + index * 0.04 : 220 - index * 0.04;
      candles.push({
        date: new Date(start + day * 24 * 60 * 60 * 1000 + slot * 15 * 60 * 1000).toISOString(),
        open: close - 0.08,
        high: close + 0.35,
        low: close - 0.35,
        close,
        volume: 1_000_000
      });
    }
  }
  return candles;
}

function strongFundamentals(symbol: string) {
  return {
    symbol,
    beta: 1.2,
    marketCap: 20_000_000_000,
    avgDollarVolume20d: 900_000_000
  };
}
