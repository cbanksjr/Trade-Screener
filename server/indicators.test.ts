import { describe, expect, it } from "vitest";
import type { Candle, LowerTimeframeConfluence, LowerTimeframeContext, SqueezeState } from "../shared/types";
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
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const lowerTimeframes = bullishLowerTimeframes("none");
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

  it("requires daily squeeze for swing candidates", () => {
    const candles = bullishCompressionCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "NODAILY",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("NODAILY"),
      optionable: true,
      options: demoOptions("NODAILY", price),
      lowerTimeframes: bullishLowerTimeframes("low")
    });

    expect(result.indicators.squeezeState).not.toBe("low");
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("Daily squeeze is not active");
  });

  it("qualifies when daily squeeze is active and lower timeframes are bullish without their own squeezes", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "DAILYSQZ",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("DAILYSQZ"),
      optionable: true,
      options: demoOptions("DAILYSQZ", price),
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(isSqueezeActive(result.indicators.squeezeState)).toBe(true);
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
  });

  it("does not qualify on intraday squeeze when daily squeeze is absent", () => {
    const candles = bullishCompressionCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "INTRADAYONLY",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("INTRADAYONLY"),
      optionable: true,
      options: demoOptions("INTRADAYONLY", price),
      lowerTimeframes: bullishLowerTimeframes("high")
    });

    expect(result.lowerTimeframes?.fifteenMinute.squeezeState).toBe("high");
    expect(result.longCallDecision).toBe("Avoid");
  });

  it("requires current price to be within 1 ATR of the 21 EMA for entry", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.8;
    const result = gradeSetup({
      symbol: "ONEATR",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("ONEATR"),
      optionable: true,
      options: demoOptions("ONEATR", price),
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(result.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinOneAtrOfEma21).toBe(true);
    expect(result.longCallDecision).not.toBe("Avoid");
    expect(result.suggestedEntryArea).toContain("1 ATR");
  });

  it("flags entries extended beyond 1 ATR from the 21 EMA", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 1.2;
    const result = gradeSetup({
      symbol: "EXTENDED",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("EXTENDED"),
      optionable: true,
      options: demoOptions("EXTENDED", price),
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(result.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinOneAtrOfEma21).toBe(false);
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("Outside the 1 ATR entry zone");
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

function bullishLowerTimeframes(squeezeState: SqueezeState): LowerTimeframeConfluence {
  return {
    fifteenMinute: bullishContext("15m", squeezeState),
    thirtyMinute: bullishContext("30m", squeezeState),
    oneHour: bullishContext("1h", squeezeState),
    fourHour: bullishContext("4h", squeezeState)
  };
}

function bullishContext(timeframe: LowerTimeframeContext["timeframe"], squeezeState: SqueezeState): LowerTimeframeContext {
  return {
    timeframe,
    bias: "bullish",
    price: 105,
    ema8: 104,
    ema21: 103,
    ema34: 102,
    ema55: 101,
    ema89: 100,
    positiveEmaStack: true,
    priceAboveEmaStack: true,
    atr14: 3,
    atrDistanceFromEma21: 0.67,
    withinOneAtrOfEma21: true,
    compressionScore: squeezeState === "none" ? 60 : 85,
    compressionStatus: squeezeState === "none" ? "Neutral" : "Bullish",
    squeezeState,
    detail: timeframe + " is bullish and inside the 1 ATR entry zone."
  };
}
