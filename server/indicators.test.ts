import { describe, expect, it } from "vitest";
import type { Candle, LowerTimeframeConfluence, LowerTimeframeContext, SqueezeState } from "../shared/types";
import { demoOptions } from "./demoData";
import { activeSqueezeDotCount, latestIndicators, squeezeState } from "./indicators";
import { gradeSetup, isSqueezeActive, rankCallOptions } from "./scoring";
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
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(["A", "B"]).toContain(result.grade);
    expect(["Strong Long Call Candidate", "Moderate Long Call Candidate", "Watchlist Candidate", "Avoid"]).toContain(result.longCallDecision);
    expect(result.layerEvaluations).toHaveLength(5);
    expect(result.dailySqueezeDotCount).toBeGreaterThanOrEqual(5);
    expect(result.compressionQualityScore).toBe(result.dailySqueezeDotCount);
    expect(result.maxScore).toBe(5);
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

  it("qualifies when daily and weekly are bullish without lower-timeframe requirements", () => {
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
      lowerTimeframes: bullishLowerTimeframes("none"),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(isSqueezeActive(result.indicators.squeezeState)).toBe(true);
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.reasonsSupportingTrade.join(" ")).not.toContain("Bonus intraday squeeze");
  });

  it("requires at least 5 consecutive active daily squeeze dots", () => {
    const candles = activeDailySqueezeCandles();
    const firstFiveDotIndex = candles.findIndex((_, index) => index >= 90 && activeSqueezeDotCount(candles.slice(0, index + 1)) >= 5);
    expect(firstFiveDotIndex).toBeGreaterThan(90);
    const limitedCandles = candles.slice(0, firstFiveDotIndex);
    const indicators = latestIndicators(limitedCandles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "FOURDOTS",
      candles: limitedCandles,
      currentPrice: price,
      fundamentals: strongFundamentals("FOURDOTS"),
      optionable: true,
      options: demoOptions("FOURDOTS", price),
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(result.dailySqueezeDotCount).toBeLessThan(5);
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("At least 5 consecutive active daily squeeze dots are required");
  });

  it("ignores lower-timeframe 1 ATR proximity for grading", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "LOWEREXT",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("LOWEREXT"),
      optionable: true,
      options: demoOptions("LOWEREXT", price),
      lowerTimeframes: bullishLowerTimeframes("none", false),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.squeezeStatusByTimeframe.map((item) => item.timeframe)).toEqual(["daily", "weekly"]);
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.reasonsAgainstTrade.join(" ")).not.toContain("Outside the 1 ATR entry zone from the 21 EMA on 30m");
  });

  it("assigns A when daily qualifies and weekly is bullish without lower-timeframe data", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "TWOBULL",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("TWOBULL"),
      optionable: true,
      options: demoOptions("TWOBULL", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
  });

  it("assigns B when daily qualifies and weekly context is unavailable", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "ONEBULL",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("ONEBULL"),
      optionable: true,
      options: demoOptions("ONEBULL", price)
    });

    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
  });

  it("calculates equal-weight institutional setup score factors", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "SCORE",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("SCORE"),
      optionable: true,
      options: demoOptions("SCORE", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.institutionalFactors).toHaveLength(8);
    expect(result.institutionalFactors.find((factor) => factor.status === "Bullish")?.contribution).toBeCloseTo(12.5);
    expect(result.setupScore).toBe(Math.round(result.institutionalFactors.reduce((sum, factor) => sum + factor.contribution, 0)));
    expect(result.setupScoreStatus).toBe("Bullish");
  });

  it("caps A when sector or earnings data is missing but still allows B", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "CAPA",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "CAPA",
        beta: 1.2,
        marketCap: 20_000_000_000,
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("CAPA", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      spyCandles: bullishCompressionCandles(),
      qqqCandles: bullishCompressionCandles()
    });

    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
    expect(result.institutionalFactors.find((factor) => factor.name === "Sector Strength")?.status).toBe("Insufficient Data");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Insufficient Data");
  });

  it("blocks setups when earnings are inside the catalyst danger window", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const nearEarnings = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = gradeSetup({
      symbol: "EARN",
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("EARN"),
        lastEarningsDate: nearEarnings
      },
      optionable: true,
      options: demoOptions("EARN", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.longCallDecision).toBe("Avoid");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
  });

  it("classifies sector strength versus SPY", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const sectorStatus = (sectorCandles: Candle[]) => gradeSetup({
      symbol: "SECTOR",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("SECTOR"),
      optionable: true,
      options: demoOptions("SECTOR", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles,
      spyCandles: returnCandles(100, 0.01),
      qqqCandles: bullishCompressionCandles()
    }).institutionalFactors.find((factor) => factor.name === "Sector Strength")?.status;

    expect(sectorStatus(returnCandles(100, 0.03))).toBe("Bullish");
    expect(sectorStatus(returnCandles(100, 0.005))).toBe("Neutral");
    expect(sectorStatus(returnCandles(100, -0.04))).toBe("Bearish");
  });

  it("marks volume expansion bullish when recent volume exceeds baseline", () => {
    const candles = volumeExpandedCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "VOL",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("VOL"),
      optionable: true,
      options: demoOptions("VOL", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.institutionalFactors.find((factor) => factor.name === "Volume Expansion")?.status).toBe("Bullish");
  });

  it("keeps momentum explanation tied to the current daily momentum calculation", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "MOMO",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("MOMO"),
      optionable: true,
      options: demoOptions("MOMO", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });
    const volatilityFit = result.institutionalFactors.find((factor) => factor.name === "Volatility Fit");

    expect(typeof result.indicators.momentum).toBe("number");
    expect(typeof result.indicators.momentumImproving).toBe("boolean");
    expect(volatilityFit?.detail).toContain("momentum");
  });

  it("ignores lower-timeframe squeeze for grading and reasons", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "BONUSSQZ",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("BONUSSQZ"),
      optionable: true,
      options: demoOptions("BONUSSQZ", price),
      lowerTimeframes: bullishLowerTimeframes("high"),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.reasonsSupportingTrade.join(" ")).not.toContain("Bonus intraday squeeze confirmation");
  });

  it("does not block A grades because of bearish lower-timeframe legacy data", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "BEARLOWER",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("BEARLOWER"),
      optionable: true,
      options: demoOptions("BEARLOWER", price),
      lowerTimeframes: bearishLowerTimeframes(),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.reasonsAgainstTrade.join(" ")).not.toContain("bearish EMA structure");
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

    expect(result.lowerTimeframes?.thirtyMinute.squeezeState).toBe("high");
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

  it("blocks candidates when weekly structure is bearish", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = indicators.ema21 + indicators.atr14 * 0.5;
    const result = gradeSetup({
      symbol: "WEEKBEAR",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("WEEKBEAR"),
      optionable: true,
      options: demoOptions("WEEKBEAR", price),
      weeklyIndicators: weeklyIndicator("bearish")
    });

    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("Weekly bearish structure blocks");
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

  it("ranks only 30-180 DTE swing calls and prefers 30-90 when quality is comparable", () => {
    const ranked = rankCallOptions([
      option("SHORT", 14, 500, 200, 0.55, 4, 102),
      option("PREFERRED", 45, 500, 200, 0.55, 4, 102),
      option("LONGER", 120, 500, 200, 0.55, 4, 102),
      option("TOO-LONG", 220, 900, 900, 0.55, 2, 102)
    ], 100);

    expect(ranked.map((contract) => contract.symbol)).toEqual(["PREFERRED", "LONGER"]);
    expect(ranked.every((contract) => contract.dte !== undefined && contract.dte >= 30 && contract.dte <= 180)).toBe(true);
  });

  it("allows 91-180 DTE when contract quality is meaningfully better", () => {
    const ranked = rankCallOptions([
      option("WEAK-60", 60, 60, 25, 0.42, 30, 103),
      option("STRONG-150", 150, 2000, 600, 0.55, 3, 103)
    ], 100);

    expect(ranked[0].symbol).toBe("STRONG-150");
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

function volumeExpandedCandles(): Candle[] {
  return activeDailySqueezeCandles().map((candle, index) => ({
    ...candle,
    volume: index >= 175 ? 36_000_000 : 25_000_000
  }));
}

function returnCandles(start: number, totalReturn: number): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 40; index += 1) {
    const progress = index / 39;
    const close = start * (1 + totalReturn * progress);
    candles.push({
      date: "2026-02-" + String(index + 1).padStart(2, "0"),
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 10_000_000
    });
  }
  return candles;
}

function institutionalSetupContext() {
  return {
    sector: "Information Technology",
    sectorCandles: bullishCompressionCandles(),
    spyCandles: bullishCompressionCandles(),
    qqqCandles: bullishCompressionCandles()
  };
}

function intradayCandles(direction: "up" | "down", days = 90): Candle[] {
  const candles: Candle[] = [];
  const start = Date.UTC(2026, 0, 5, 14, 30);
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < 13; slot += 1) {
      const index = day * 13 + slot;
      const close = direction === "up" ? 100 + index * 0.08 : 220 - index * 0.08;
      candles.push({
        date: new Date(start + day * 24 * 60 * 60 * 1000 + slot * 30 * 60 * 1000).toISOString(),
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
    avgDollarVolume20d: 900_000_000,
    lastEarningsDate: "2027-12-31"
  };
}

function weeklyIndicator(bias: "bullish" | "bearish" | "neutral", squeezeState: SqueezeState = "none") {
  const emaValues = bias === "bullish"
    ? { ema8: 120, ema21: 115, ema34: 110, ema55: 105, ema89: 100 }
    : bias === "bearish"
      ? { ema8: 160, ema21: 161, ema34: 162, ema55: 163, ema89: 164 }
      : { ema8: 120, ema21: 121, ema34: 110, ema55: 105, ema89: 100 };
  return {
    ...emaValues,
    atr14: 8,
    atrContracting: true,
    bbUpper: 151,
    bbLower: 147,
    bbWidth: 2.7,
    bbContracting: true,
    kcLowUpper: 153,
    kcLowLower: 145,
    kcMidUpper: 154,
    kcMidLower: 144,
    kcHighUpper: 155,
    kcHighLower: 143,
    momentum: 1,
    momentumImproving: true,
    candleRangeContracting: true,
    squeezeState
  };
}

function bullishLowerTimeframes(squeezeState: SqueezeState, withinOneAtrOfEma21 = true): LowerTimeframeConfluence {
  return {
    thirtyMinute: bullishContext("30m", squeezeState, withinOneAtrOfEma21),
    oneHour: bullishContext("1h", squeezeState, withinOneAtrOfEma21),
    fourHour: bullishContext("4h", squeezeState, withinOneAtrOfEma21)
  };
}

function bearishLowerTimeframes(): LowerTimeframeConfluence {
  return {
    thirtyMinute: bearishContext("30m"),
    oneHour: bearishContext("1h"),
    fourHour: bearishContext("4h")
  };
}

function mixedLowerTimeframes(bullishCount: number): LowerTimeframeConfluence {
  const contexts: LowerTimeframeContext[] = [
    bullishCount >= 1 ? bullishContext("30m", "none") : neutralContext("30m"),
    bullishCount >= 2 ? bullishContext("1h", "none") : neutralContext("1h"),
    bullishCount >= 3 ? bullishContext("4h", "none") : neutralContext("4h")
  ];
  return {
    thirtyMinute: contexts[0],
    oneHour: contexts[1],
    fourHour: contexts[2]
  };
}

function bullishContext(timeframe: LowerTimeframeContext["timeframe"], squeezeState: SqueezeState, withinOneAtrOfEma21 = true): LowerTimeframeContext {
  return {
    timeframe,
    bias: "bullish",
    price: withinOneAtrOfEma21 ? 105 : 110,
    ema8: 104,
    ema21: 103,
    ema34: 102,
    ema55: 101,
    ema89: 100,
    positiveEmaStack: true,
    priceAboveEmaStack: true,
    atr14: 3,
    atrDistanceFromEma21: withinOneAtrOfEma21 ? 0.67 : 2.33,
    withinOneAtrOfEma21,
    compressionScore: squeezeState === "none" ? 60 : 85,
    compressionStatus: squeezeState === "none" ? "Neutral" : "Bullish",
    squeezeState,
    detail: timeframe + " is bullish and " + (withinOneAtrOfEma21 ? "inside" : "outside") + " the 1 ATR entry zone."
  };
}

function bearishContext(timeframe: LowerTimeframeContext["timeframe"]): LowerTimeframeContext {
  return {
    timeframe,
    bias: "bearish",
    price: 96,
    ema8: 97,
    ema21: 98,
    ema34: 99,
    ema55: 100,
    ema89: 101,
    positiveEmaStack: false,
    priceAboveEmaStack: false,
    atr14: 3,
    atrDistanceFromEma21: -0.67,
    withinOneAtrOfEma21: false,
    compressionScore: 20,
    compressionStatus: "Bearish",
    squeezeState: "none",
    detail: timeframe + " is bearish."
  };
}

function neutralContext(timeframe: LowerTimeframeContext["timeframe"]): LowerTimeframeContext {
  return {
    timeframe,
    bias: "neutral",
    price: 105,
    ema8: 103,
    ema21: 104,
    ema34: 102,
    ema55: 101,
    ema89: 100,
    positiveEmaStack: false,
    priceAboveEmaStack: true,
    atr14: 3,
    atrDistanceFromEma21: 0.33,
    withinOneAtrOfEma21: true,
    compressionScore: 50,
    compressionStatus: "Neutral",
    squeezeState: "none",
    detail: timeframe + " is neutral."
  };
}

function option(symbol: string, dte: number, openInterest: number, volume: number, delta: number, spreadPct: number, strike: number) {
  const mid = 5;
  const ask = mid * (1 + spreadPct / 200);
  const bid = mid * (1 - spreadPct / 200);
  return {
    symbol,
    description: symbol,
    expirationDate: "2026-09-18",
    strike,
    optionType: "call" as const,
    bid,
    ask,
    last: mid,
    volume,
    openInterest,
    delta,
    dte,
    spreadPct,
    score: 75
  };
}
