import { describe, expect, it } from "vitest";
import type { Candle, IndicatorSnapshot, LowerTimeframeConfluence } from "../shared/types";
import { demoCandles, demoOptions } from "./demoData";
import { latestIndicators, squeezeState } from "./indicators";
import { gradeSetup, isSqueezeActive } from "./scoring";

describe("indicator calculations", () => {
  it("calculates the core swing indicators from candle history", () => {
    const indicators = latestIndicators(demoCandles("AAPL"));
    expect(indicators.ema21).toBeGreaterThan(0);
    expect(indicators.ema50).toBeGreaterThan(0);
    expect(indicators.atr14).toBeGreaterThan(0);
    expect(["none", "low", "mid", "high", "released"]).toContain(indicators.squeezeState);
  });

  it("classifies Squeeze Pro levels from Bollinger/Keltner envelopes", () => {
    expect(squeezeState(100, 100, 102, 98, 101, 99, 100, 100)).toBe("high");
    expect(squeezeState(100.5, 99.5, 102, 98, 101, 99, 100, 100)).toBe("mid");
    expect(squeezeState(101.5, 98.5, 102, 98, 101, 99, 100, 100)).toBe("low");
    expect(squeezeState(102.5, 97.5, 102, 98, 101, 99, 100, 100)).toBe("released");
  });

  it("counts equal Bollinger and Keltner envelopes as in-squeeze", () => {
    expect(squeezeState(100, 100, 102, 98, 101, 99, 100, 100)).toBe("high");
    expect(squeezeState(101, 99, 102, 98, 101, 99, 100, 100)).toBe("mid");
    expect(squeezeState(102, 98, 102, 98, 101, 99, 100, 100)).toBe("low");
  });

  it("requires both Bollinger bands to fit inside the selected Keltner width", () => {
    expect(squeezeState(100, 97.5, 102, 98, 101, 99, 100, 100)).toBe("released");
    expect(squeezeState(101, 98.5, 102, 98, 101, 99, 100, 100)).toBe("low");
  });
});

describe("transparent grading", () => {
  it("treats only low, mid, and high as qualifying squeeze states", () => {
    expect(isSqueezeActive("low")).toBe(true);
    expect(isSqueezeActive("mid")).toBe(true);
    expect(isSqueezeActive("high")).toBe(true);
    expect(isSqueezeActive("released")).toBe(false);
    expect(isSqueezeActive("none")).toBe(false);
  });

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

  it("does not allow A+ without an active daily squeeze", () => {
    const candles = noSqueezeBullishCandles();
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "NOSQZ",
      candles,
      fundamentals: strongFundamentals("NOSQZ"),
      optionable: true,
      options: demoOptions("NOSQZ", price),
      lowerTimeframes: bullishConfluence()
    });

    expect(isSqueezeActive(result.indicators.squeezeState)).toBe(false);
    expect(result.rules.find((rule) => rule.id === "daily-squeeze")?.passed).toBe(false);
    expect(result.grade).not.toBe("A+");
  });

  it("keeps squeeze calculations based on OHLC candles when a live quote price is provided", () => {
    const candles = noSqueezeBullishCandles();
    const candleSqueeze = latestIndicators(candles).squeezeState;
    const result = gradeSetup({
      symbol: "QUOTEONLY",
      candles,
      currentPrice: candles[candles.length - 1].close + 15,
      fundamentals: strongFundamentals("QUOTEONLY"),
      optionable: true,
      options: demoOptions("QUOTEONLY", candles[candles.length - 1].close),
      lowerTimeframes: bullishConfluence()
    });

    expect(result.price).toBe(candles[candles.length - 1].close + 15);
    expect(result.indicators.squeezeState).toBe(candleSqueeze);
  });


  it("does not switch bearish setups into short screening", () => {
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

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "ema-stack")?.passed).toBe(false);
    expect(result.rules.find((rule) => rule.id === "price-side")?.passed).toBe(false);
    expect(result.suggestedOptions.every((contract) => contract.optionType === "call")).toBe(true);
  });


  it("passes long ATR distance when price is within +1.25 ATR of the 21 EMA", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 1.22);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "LONGATR",
      candles,
      fundamentals: strongFundamentals("LONGATR"),
      optionable: true,
      options: demoOptions("LONGATR", price),
      lowerTimeframes: bullishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "near-ema")?.passed).toBe(true);
  });

  it("fails long ATR distance when price is beyond +1.25 ATR of the 21 EMA", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 1.35);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "LONGFAR",
      candles,
      fundamentals: strongFundamentals("LONGFAR"),
      optionable: true,
      options: demoOptions("LONGFAR", price),
      lowerTimeframes: bullishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "near-ema")?.passed).toBe(false);
  });

  it("fails long ATR distance when price is below the 21 EMA", () => {
    const candles = candlesAtSignedAtr(bearishCandles(), -1.22);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "SHORTATR",
      candles,
      fundamentals: strongFundamentals("SHORTATR"),
      optionable: true,
      options: demoOptions("SHORTATR", price),
      lowerTimeframes: bearishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "near-ema")?.passed).toBe(false);
  });

  it("still fails long ATR distance when price is far below the 21 EMA", () => {
    const candles = candlesAtSignedAtr(bearishCandles(), -1.35);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "SHORTFAR",
      candles,
      fundamentals: strongFundamentals("SHORTFAR"),
      optionable: true,
      options: demoOptions("SHORTFAR", price),
      lowerTimeframes: bearishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "near-ema")?.passed).toBe(false);
  });

  it("adds weighted bullish 1h and 4h confluence to long setups", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 0.6);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "BULLCONF",
      candles,
      fundamentals: strongFundamentals("BULLCONF"),
      optionable: true,
      options: demoOptions("BULLCONF", price),
      lowerTimeframes: bullishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "1h-confluence")?.passed).toBe(true);
    expect(result.rules.find((rule) => rule.id === "4h-confluence")?.passed).toBe(true);
  });

  it("does not score bearish 1h and 4h confluence for long setups", () => {
    const candles = candlesAtSignedAtr(bearishCandles(), -0.6);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "BEARCONF",
      candles,
      fundamentals: strongFundamentals("BEARCONF"),
      optionable: true,
      options: demoOptions("BEARCONF", price),
      lowerTimeframes: bearishConfluence()
    });

    expect(result.setupDirection).toBe("long");
    expect(result.rules.find((rule) => rule.id === "1h-confluence")?.passed).toBe(false);
    expect(result.rules.find((rule) => rule.id === "4h-confluence")?.passed).toBe(false);
  });

  it("keeps weekly squeeze visible without adding it to the grading rules", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 0.6);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "WEEKLYSQZ",
      candles,
      fundamentals: strongFundamentals("WEEKLYSQZ"),
      optionable: true,
      options: demoOptions("WEEKLYSQZ", price),
      lowerTimeframes: bullishConfluence(),
      weeklyIndicators: indicatorWithSqueeze("mid")
    });

    expect(result.weeklyIndicators?.squeezeState).toBe("mid");
    expect(result.rules.some((rule) => rule.id === "weekly-squeeze")).toBe(false);
  });

  it("does not change the score when weekly squeeze is absent", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 0.6);
    const price = candles[candles.length - 1].close;
    const withWeeklySqueeze = gradeSetup({
      symbol: "WITHWEEKLYSQZ",
      candles,
      fundamentals: strongFundamentals("WITHWEEKLYSQZ"),
      optionable: true,
      options: demoOptions("WITHWEEKLYSQZ", price),
      lowerTimeframes: bullishConfluence(),
      weeklyIndicators: indicatorWithSqueeze("mid")
    });
    const withoutWeeklySqueeze = gradeSetup({
      symbol: "NOWEEKLYSQZ",
      candles,
      fundamentals: strongFundamentals("NOWEEKLYSQZ"),
      optionable: true,
      options: demoOptions("NOWEEKLYSQZ", price),
      lowerTimeframes: bullishConfluence(),
      weeklyIndicators: indicatorWithSqueeze("none")
    });

    expect(withWeeklySqueeze.score).toBe(withoutWeeklySqueeze.score);
    expect(withWeeklySqueeze.maxScore).toBe(withoutWeeklySqueeze.maxScore);
  });

  it("fails missing lower-timeframe confluence rules without failing the universe", () => {
    const candles = candlesAtSignedAtr(bullishCandles(), 0.6);
    const price = candles[candles.length - 1].close;
    const result = gradeSetup({
      symbol: "NOCONF",
      candles,
      fundamentals: strongFundamentals("NOCONF"),
      optionable: true,
      options: demoOptions("NOCONF", price)
    });

    expect(result.passesUniverse).toBe(true);
    expect(result.rules.find((rule) => rule.id === "1h-confluence")?.passed).toBe(false);
    expect(result.rules.find((rule) => rule.id === "4h-confluence")?.passed).toBe(false);
    expect(result.warnings).toContain("Lower-timeframe confluence unavailable; 1h/4h rules were not scored.");
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

function bullishCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 180; index += 1) {
    const close = 90 + index * 0.45 + Math.sin(index / 6) * 1.2;
    candles.push({
      date: "2026-02-" + String(index + 1).padStart(2, "0"),
      open: close - 0.4,
      high: close + 2.4,
      low: close - 2.4,
      close,
      volume: 25_000_000
    });
  }
  return candles;
}

function noSqueezeBullishCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 180; index += 1) {
    const close = 100 + index * 0.5 + Math.sin(index / 20) * 40;
    candles.push({
      date: "2026-03-" + String(index + 1).padStart(2, "0"),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 25_000_000
    });
  }
  return candlesAtSignedAtr(candles, 0.2);
}

function candlesAtSignedAtr(candles: Candle[], signedAtrDistance: number): Candle[] {
  const adjusted = candles.map((candle) => ({ ...candle }));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const indicators = latestIndicators(adjusted);
    const target = indicators.ema21 + indicators.atr14 * signedAtrDistance;
    const lastIndex = adjusted.length - 1;
    adjusted[lastIndex] = {
      ...adjusted[lastIndex],
      open: target,
      high: target + 2.4,
      low: target - 2.4,
      close: target
    };
  }
  return adjusted;
}

function strongFundamentals(symbol: string) {
  return {
    symbol,
    beta: 1.2,
    marketCap: 20_000_000_000,
    avgDollarVolume20d: 900_000_000
  };
}

function bullishConfluence(): LowerTimeframeConfluence {
  return {
    oneHour: { timeframe: "1h", bias: "bullish", price: 110, ema21: 106, ema50: 100, squeezeState: "low", detail: "1h is bullish." },
    fourHour: { timeframe: "4h", bias: "bullish", price: 112, ema21: 107, ema50: 101, squeezeState: "mid", detail: "4h is bullish." }
  };
}

function bearishConfluence(): LowerTimeframeConfluence {
  return {
    oneHour: { timeframe: "1h", bias: "bearish", price: 90, ema21: 94, ema50: 100, squeezeState: "low", detail: "1h is bearish." },
    fourHour: { timeframe: "4h", bias: "bearish", price: 88, ema21: 93, ema50: 101, squeezeState: "mid", detail: "4h is bearish." }
  };
}

function indicatorWithSqueeze(squeezeState: IndicatorSnapshot["squeezeState"]): IndicatorSnapshot {
  return {
    ...latestIndicators(bullishCandles()),
    squeezeState
  };
}
