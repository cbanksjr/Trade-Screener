import { describe, expect, it } from "vitest";
import type { Candle, LowerTimeframeConfluence, LowerTimeframeContext, SqueezeState } from "../shared/types";
import { demoOptions } from "./demoData";
import {
  activeSqueezeDotCount,
  ema,
  latestIndicators,
  linearRegressionLast,
  MIN_CANDLES_REQUIRED,
  squeezeMomentumColor,
  squeezeMomentumSeries,
  squeezeState
} from "./indicators";
import type { MacroRegimeContext } from "./macroRegime";
import {
  BEARISH_MACRO_GRADE_CAP_REASON,
  DEVELOPING_SQUEEZE_GRADE_CAP_REASON,
  EXTENDED_ENTRY_GRADE_CAP_REASON,
  RELAXED_TREND_GRADE_CAP_REASON,
  RELAXED_WEEKLY_GRADE_CAP_REASON,
  WEEKLY_ATR_GRADE_CAP_REASON,
  applyInstitutionalEdge,
  gradeSetup,
  isSqueezeActive,
  rankCallOptions,
  resolveWeeklyQualificationMode
} from "./scoring";
import { buildLowerTimeframeConfluence } from "./timeframes";

describe("indicator calculations", () => {
  it("seeds the EMA with a simple moving average instead of the first raw value", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const series = ema(values, 3);

    expect(series[0]).toBeNaN();
    expect(series[1]).toBeNaN();
    expect(series[2]).toBeCloseTo(2);
    expect(series[3]).toBeCloseTo(3);
    expect(series[4]).toBeCloseTo(4);
    expect(series[9]).toBeCloseTo(9);
  });

  it("falls back to an SMA of the whole series when it is shorter than the period", () => {
    const series = ema([2, 4, 6], 5);

    expect(series).toEqual([NaN, NaN, 4]);
  });

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
    expect(["cyan", "blue", "red", "yellow"]).toContain(indicators.momentumColor);
  });

  it("requires MIN_CANDLES_REQUIRED candles and matches indicators.ts's real threshold", () => {
    expect(MIN_CANDLES_REQUIRED).toBe(90);
    const makeCandles = (length: number) => Array.from({ length }, (_, index) => ({
      date: "2026-01-" + String(index + 1).padStart(2, "0"),
      open: index,
      high: index + 1,
      low: index - 1,
      close: index,
      volume: 1_000_000
    }));

    expect(() => latestIndicators(makeCandles(MIN_CANDLES_REQUIRED - 1))).toThrow(
      "At least " + MIN_CANDLES_REQUIRED + " candles are required to calculate the compression setup."
    );
    expect(() => latestIndicators(makeCandles(MIN_CANDLES_REQUIRED))).not.toThrow();
  });

  it("matches the naive per-window recomputation of active squeeze dot counts", () => {
    const referenceActiveSqueezeDotCount = (candles: Candle[]): number => {
      let count = 0;
      for (let end = candles.length; end >= MIN_CANDLES_REQUIRED; end -= 1) {
        const state = latestIndicators(candles.slice(0, end)).squeezeState;
        if (!(state === "low" || state === "mid" || state === "high")) break;
        count += 1;
      }
      return count;
    };

    const fixtures = [bullishCompressionCandles(), activeDailySqueezeCandles(), bearishMarketCandles()];
    const sampleEndOffsets = [0, -1, -20, -40];

    for (const candles of fixtures) {
      for (const offset of sampleEndOffsets) {
        const end = candles.length + offset;
        if (end < MIN_CANDLES_REQUIRED) continue;
        const truncated = candles.slice(0, end);
        expect(activeSqueezeDotCount(truncated)).toBe(referenceActiveSqueezeDotCount(truncated));
      }
    }
  });

  it("uses the least-squares regression endpoint for the Squeeze histogram", () => {
    expect(linearRegressionLast([1, 2, 3])).toBeCloseTo(3);
    expect(linearRegressionLast([1, 2, 4])).toBeCloseTo(23 / 6);
  });

  it("calculates the canonical 20-bar Squeeze momentum histogram", () => {
    const candles = Array.from({ length: 90 }, (_, index) => ({
      date: "2026-01-" + String(index + 1).padStart(2, "0"),
      open: index,
      high: index + 1,
      low: index - 1,
      close: index,
      volume: 1_000_000
    }));
    const series = squeezeMomentumSeries(candles);
    const indicators = latestIndicators(candles);

    expect(series.at(-1)).toBeCloseTo(9.5);
    expect(indicators.momentum).toBeCloseTo(9.5);
    expect(indicators.momentumImproving).toBe(false);
    expect(indicators.momentumColor).toBe("blue");
  });

  it("maps Squeeze histogram sign and direction to platform colors", () => {
    expect(squeezeMomentumColor(2, 1)).toBe("cyan");
    expect(squeezeMomentumColor(1, 2)).toBe("blue");
    expect(squeezeMomentumColor(-2, -1)).toBe("red");
    expect(squeezeMomentumColor(-1, -2)).toBe("yellow");
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

  it("returns score-band grades from the weighted setup score", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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

    expect(["A", "B", "C"]).toContain(result.grade);
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
    const price = preferredEntryPrice(indicators);
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

  it("rejects an active Daily squeeze when the histogram is not above zero", () => {
    const candles = activeDailySqueezeCandles().map((candle, index, all) => ({
      ...candle,
      close: candle.close - Math.max(0, index - (all.length - 20)) * 0.25
    }));
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "NEGATIVEHIST",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("NEGATIVEHIST"),
      optionable: true,
      options: demoOptions("NEGATIVEHIST", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(isSqueezeActive(result.indicators.squeezeState)).toBe(true);
    expect(result.indicators.momentum).toBeLessThanOrEqual(0);
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("histogram");
  });

  it("qualifies 2-4 active daily squeeze dots as a developing B setup", () => {
    const candles = activeDailySqueezeCandles();
    const firstFiveDotIndex = candles.findIndex((_, index) => index >= 90 && activeSqueezeDotCount(candles.slice(0, index + 1)) >= 5);
    expect(firstFiveDotIndex).toBeGreaterThan(90);
    const limitedCandles = candles.slice(0, firstFiveDotIndex);
    const indicators = latestIndicators(limitedCandles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "FOURDOTS",
      candles: limitedCandles,
      currentPrice: price,
      fundamentals: strongFundamentals("FOURDOTS"),
      optionable: true,
      options: demoOptions("FOURDOTS", price),
      lowerTimeframes: bullishLowerTimeframes("none"),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.dailySqueezeDotCount).toBeGreaterThanOrEqual(2);
    expect(result.dailySqueezeDotCount).toBeLessThan(5);
    expect(result.squeezeMaturityMode).toBe("developing");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
    expect(result.gradeCapReasons).toContain(DEVELOPING_SQUEEZE_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  });

  it("rejects daily squeezes with fewer than 2 active dots", () => {
    const candles = activeDailySqueezeCandles();
    const firstTwoDotIndex = candles.findIndex((_, index) => index >= 90 && activeSqueezeDotCount(candles.slice(0, index + 1)) >= 2);
    expect(firstTwoDotIndex).toBeGreaterThanOrEqual(90);
    const limitedCandles = candles.slice(0, firstTwoDotIndex);
    const indicators = latestIndicators(limitedCandles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "ONEDOT",
      candles: limitedCandles,
      currentPrice: price,
      fundamentals: strongFundamentals("ONEDOT"),
      optionable: true,
      options: demoOptions("ONEDOT", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(result.dailySqueezeDotCount).toBeLessThan(2);
    expect(result.squeezeMaturityMode).toBe("insufficient");
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("At least 2 consecutive active daily squeeze dots are required");
  });

  it("ignores lower-timeframe entry proximity for grading", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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
    expect(result.reasonsAgainstTrade.join(" ")).not.toContain("Outside the EMA pocket on 30m");
  });

  it("assigns A when daily qualifies and weekly is bullish without lower-timeframe data", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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

  it("does not avoid when weekly context is unavailable", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "ONEBULL",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("ONEBULL"),
      optionable: true,
      options: demoOptions("ONEBULL", price)
    });

    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.tradeMark).toBe("Take");
  });

  it("calculates weighted setup score factors", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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

    expect(result.institutionalFactors).toHaveLength(6);
    expect(result.institutionalFactors.find((factor) => factor.name === "Daily Structure")?.contribution).toBe(30);
    expect(result.setupScore).toBe(Math.round(result.institutionalFactors.reduce((sum, factor) => sum + factor.contribution, 0)));
    expect(result.setupScoreStatus).toBe("Bullish");
  });

  it("assigns C when setup score is below the B threshold", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "LOWA",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("LOWA"),
      optionable: true,
      options: [option("LOWA", 45, 500, 200, 0.55, 4, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: returnCandles(100, 0.005),
      spyCandles: returnCandles(100, 0.01)
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(70);
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
    expect(result.gradeCapReasons).toContain("Setup score below 90.");
  });

  it("assigns A when a setup score reaches the A band", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "HIGHCAP",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "HIGHCAP",
        beta: 1.2,
        marketCap: 20_000_000_000,
        avgDollarVolume20d: 900_000_000,
        nextEarningsDate: "2027-12-31"
      },
      optionable: true,
      options: demoOptions("HIGHCAP", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: activeDailySqueezeCandles(),
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(90);
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
  });

  it("caps the grade at B when the setup score reaches the A band but Catalyst Safety data is missing", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "NOCATALYST",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "NOCATALYST",
        beta: 1.2,
        marketCap: 20_000_000_000,
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("NOCATALYST", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: activeDailySqueezeCandles(),
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(90);
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Insufficient Data");
    expect(result.grade).toBe("B");
    expect(result.gradeCapReasons).toContain("Catalyst Safety unavailable.");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
  });

  it("allows neutral weekly structure without capping the setup", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "WEEKLYCAP",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("WEEKLYCAP"),
      optionable: true,
      options: demoOptions("WEEKLYCAP", price),
      weeklyIndicators: weeklyIndicator("neutral"),
      ...institutionalSetupContext()
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(90);
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.gradeCapReasons).not.toContain(RELAXED_WEEKLY_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  });

  it("keeps mixed weekly structure within one ATR as context only", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "WEEKLYATR",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("WEEKLYATR"),
      optionable: true,
      options: demoOptions("WEEKLYATR", price),
      weeklyIndicators: weeklyProximityIndicator(price, 0.5),
      ...institutionalSetupContext()
    });

    expect(result.weeklyQualificationMode).toBe("ema21-atr");
    expect(result.setupScore).toBeGreaterThanOrEqual(90);
    expect(result.grade).toBe("A");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.gradeCapReasons).not.toContain(WEEKLY_ATR_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
  });

  it("uses inclusive weekly 21 EMA and one ATR boundaries", () => {
    const price = 100;

    expect(resolveWeeklyQualificationMode(weeklyProximityIndicator(price, 0), price)).toBe("ema21-atr");
    expect(resolveWeeklyQualificationMode(weeklyProximityIndicator(price, 1), price)).toBe("ema21-atr");
    expect(resolveWeeklyQualificationMode(weeklyProximityIndicator(price, -0.01), price)).toBe("none");
    expect(resolveWeeklyQualificationMode(weeklyProximityIndicator(price, 1.01), price)).toBe("none");
  });

  it("keeps full weekly stack qualified even when price is more than one ATR above the 21 EMA", () => {
    const indicators = weeklyIndicator("bullish");
    const price = indicators.ema21 + indicators.atr14 * 3;

    expect(resolveWeeklyQualificationMode(indicators, price)).toBe("full-stack");
  });

  it("keeps missing sector and earnings in the setup score", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(70);
    expect(result.setupScore).toBeLessThan(90);
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
    expect(result.institutionalFactors.find((factor) => factor.name === "Sector Strength")?.status).toBe("Insufficient Data");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Insufficient Data");
  });

  it("allows A when FMP fills sector and earnings context", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "AVFILL",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "AVFILL",
        beta: 1.2,
        marketCap: 20_000_000_000,
        avgDollarVolume20d: 900_000_000,
        sector: "Information Technology",
        nextEarningsDate: "2027-12-31",
        sources: {
          sector: "fmp",
          nextEarningsDate: "fmp"
        }
      },
      optionable: true,
      options: demoOptions("AVFILL", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sectorCandles: activeDailySqueezeCandles(),
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.institutionalFactors.find((factor) => factor.name === "Sector Strength")?.status).toBe("Bullish");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
    expect(result.fundamentalSources).toMatchObject({
      sector: "fmp",
      nextEarningsDate: "fmp"
    });
  });

  it("scores ETFs without beta, market cap, sector, or earnings penalties", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "SMH",
      assetType: "etf",
      candles,
      currentPrice: price,
      fundamentals: {
        symbol: "SMH",
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("SMH", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.assetType).toBe("etf");
    expect(result.nextEarningsDate).toBeUndefined();
    expect(result.daysUntilNextEarnings).toBeUndefined();
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.grade).toBe("A");
    expect(result.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bullish");
    expect(result.institutionalFactors.find((factor) => factor.name === "Sector Strength")?.detail).toBe("SMH ETF outperforming SPY over 20 periods.");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("ETF has no single-company earnings date; catalyst risk is not applicable.");
  });

  it("classifies catalyst safety by earnings distance", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (daysUntilEarnings: number) => gradeSetup({
      symbol: "EARN" + daysUntilEarnings,
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("EARN" + daysUntilEarnings),
        nextEarningsDate: futureDate(daysUntilEarnings)
      },
      optionable: true,
      options: demoOptions("EARN" + daysUntilEarnings, price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    const fiveDay = resultFor(5);
    const fourteenDay = resultFor(14);
    const fifteenDay = resultFor(15);
    const twentyNineDay = resultFor(29);
    const thirtyDay = resultFor(30);
    const fortyFiveDay = resultFor(45);

    expect(fiveDay.longCallDecision).toBe("Avoid");
    expect(fiveDay.nextEarningsDate).toBeDefined();
    expect(fiveDay.daysUntilNextEarnings).toBe(5);
    expect(fiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
    expect(fiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Next earnings " + fiveDay.nextEarningsDate?.slice(0, 10) + " is within 14 days.");
    expect(fourteenDay.longCallDecision).toBe("Avoid");
    expect(fourteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
    expect(fifteenDay.longCallDecision).not.toBe("Avoid");
    expect(fifteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Neutral");
    expect(fifteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Next earnings " + fifteenDay.nextEarningsDate?.slice(0, 10) + " is 15-29 days away; catalyst risk is elevated.");
    expect(twentyNineDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Neutral");
    expect(thirtyDay.longCallDecision).toBe("Strong Long Call Candidate");
    expect(thirtyDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
    expect(thirtyDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Next earnings " + thirtyDay.nextEarningsDate?.slice(0, 10) + " is at least 30 days away.");
    expect(fortyFiveDay.longCallDecision).toBe("Strong Long Call Candidate");
    expect(fortyFiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
  });

  it("bases catalyst safety on the scan run date", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const scanRanAt = new Date("2026-07-01T23:30:00-05:00");
    const result = gradeSetup({
      symbol: "SCANRANAT",
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("SCANRANAT"),
        nextEarningsDate: "2026-07-15"
      },
      optionable: true,
      options: demoOptions("SCANRANAT", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      scanRanAt,
      ...institutionalSetupContext()
    });

    expect(result.lastUpdated).toBe(scanRanAt.toISOString());
    expect(result.nextEarningsDate).toBe("2026-07-15");
    // scanRanAt is 2026-07-01T23:30:00-05:00, i.e. 2026-07-02T04:30:00Z — already
    // July 2nd in UTC, so the gap to July 15th is 13 days, not 14.
    expect(result.daysUntilNextEarnings).toBe(13);
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
    expect(result.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Next earnings 2026-07-15 is within 14 days.");
  });

  it("classifies sector strength versus SPY", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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

  it("does not grade volume expansion because squeeze setups can stay quiet before breakout", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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

    expect(result.institutionalFactors.map((factor) => factor.name)).not.toContain("Volume Expansion");
  });

  it("keeps momentum explanation tied to the current daily momentum calculation", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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
    const volatilityFit = result.institutionalFactors.find((factor) => factor.name === "Compression Quality");

    expect(typeof result.indicators.momentum).toBe("number");
    expect(typeof result.indicators.momentumImproving).toBe("boolean");
    expect(volatilityFit?.detail).toContain("momentum");
  });

  it("keeps bearish macro regime as narrative context without vetoing the trade mark", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "MACROCAUTION",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("MACROCAUTION"),
      optionable: true,
      options: demoOptions("MACROCAUTION", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: candles,
      spyCandles: bearishMarketCandles(),
      qqqCandles: bearishMarketCandles(),
      macroRegime: bearishMacroRegime()
    });

    expect(result.layerEvaluations.find((layer) => layer.layer === "Macro Regime")?.status).toBe("Bearish");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.tradeMark).toBe("Take");
    expect(result.grade).toBe("A");
    expect(result.tradeMarkReasons).not.toContain(BEARISH_MACRO_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(BEARISH_MACRO_GRADE_CAP_REASON);
    expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);

    const enriched = applyInstitutionalEdge(result, {
      score: 100,
      status: "Bullish",
      adjustment: 5,
      factors: [],
      warnings: []
    });
    expect(enriched.longCallDecision).toBe("Strong Long Call Candidate");
    expect(enriched.grade).toBe("A");
  });

  it("ignores lower-timeframe squeeze for grading and reasons", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
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
    const price = preferredEntryPrice(indicators);
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

  it("allows preferred entries from the 34 EMA through the 8 EMA", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const lowerPocketPrice = indicators.ema34;
    const upperPocketPrice = indicators.ema8;
    const resultAtLowerPocket = gradeSetup({
      symbol: "ABOVE21",
      candles,
      currentPrice: lowerPocketPrice,
      fundamentals: strongFundamentals("ABOVE21"),
      optionable: true,
      options: demoOptions("ABOVE21", lowerPocketPrice),
      lowerTimeframes: bullishLowerTimeframes("none"),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });
    const resultAtUpperPocket = gradeSetup({
      symbol: "BELOW8",
      candles,
      currentPrice: upperPocketPrice,
      fundamentals: strongFundamentals("BELOW8"),
      optionable: true,
      options: demoOptions("BELOW8", upperPocketPrice),
      lowerTimeframes: bullishLowerTimeframes("none"),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(resultAtLowerPocket.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinEmaPocket).toBe(true);
    expect(resultAtLowerPocket.longCallDecision).not.toBe("Avoid");
    expect(resultAtUpperPocket.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinEmaPocket).toBe(true);
    expect(resultAtUpperPocket.longCallDecision).not.toBe("Avoid");
    expect(resultAtLowerPocket.dailyEntryQualificationMode).toBe("strict");
    expect(resultAtUpperPocket.dailyEntryQualificationMode).toBe("strict");
    expect(resultAtLowerPocket.suggestedEntryArea).toContain("preferred zone");
  });

  it("qualifies the inclusive 21 EMA-to-8 EMA boundaries as preferred entries", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const atEma21 = gradeSetup({
      symbol: "ATEMA21",
      candles,
      currentPrice: indicators.ema21,
      fundamentals: strongFundamentals("ATEMA21"),
      optionable: true,
      options: demoOptions("ATEMA21", indicators.ema21),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });
    const atEma8 = gradeSetup({
      symbol: "ATEMA8",
      candles,
      currentPrice: indicators.ema8,
      fundamentals: strongFundamentals("ATEMA8"),
      optionable: true,
      options: demoOptions("ATEMA8", indicators.ema8),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    for (const result of [atEma21, atEma8]) {
      expect(result.dailyEntryQualificationMode).toBe("strict");
      expect(result.longCallDecision).toBe("Strong Long Call Candidate");
      expect(result.grade).toBe("A");
      expect(result.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
    }
  });

  it("allows controlled extension above the preferred zone but rejects below the 34 EMA or beyond 1.5 ATR", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const resultFor = (symbol: string, price: number) => gradeSetup({
      symbol,
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals(symbol),
      optionable: true,
      options: demoOptions(symbol, price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });
    const below = resultFor("BELOW34", indicators.ema34 * 0.9999);
    const extendedPrice = Math.max(indicators.ema8 * 1.0001, indicators.ema21 + indicators.atr14 * 1.1);
    const extended = resultFor("EXTENDED", extendedPrice);
    const overextended = resultFor("OVEREXTENDED", indicators.ema21 + indicators.atr14 * 1.51);

    expect(below.dailyEntryQualificationMode).toBe("none");
    expect(below.longCallDecision).toBe("Avoid");
    expect(extended.dailyEntryQualificationMode).toBe("extended");
    expect(extended.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(extended.grade).toBe("B");
    expect(extended.gradeCapReasons).toContain(EXTENDED_ENTRY_GRADE_CAP_REASON);
    expect(extended.gradeCapReasons).not.toContain(RELAXED_TREND_GRADE_CAP_REASON);
    expect(overextended.dailyEntryQualificationMode).toBe("none");
    expect(overextended.longCallDecision).toBe("Avoid");
    expect(overextended.reasonsAgainstTrade.join(" ")).toContain("more than 1.5 ATR");
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

  it("does not block candidates when weekly structure is bearish", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "WEEKBEAR",
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("WEEKBEAR"),
      optionable: true,
      options: demoOptions("WEEKBEAR", price),
      weeklyIndicators: weeklyIndicator("bearish")
    });

    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.tradeMark).toBe("Take");
    expect(result.reasonsAgainstTrade.join(" ")).not.toContain("Weekly EMA structure is bearish");
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

  it("requires stocks to have at least 0.75 beta", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (beta: number) => gradeSetup({
      symbol: "BETA" + beta,
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("BETA" + beta),
        beta
      },
      optionable: true,
      options: demoOptions("BETA" + beta, price),
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });
    const lowBeta = resultFor(0.74);
    const qualifiedBeta = resultFor(0.75);

    expect(lowBeta.passesUniverse).toBe(false);
    expect(lowBeta.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bearish");
    expect(lowBeta.longCallDecision).toBe("Avoid");
    expect(qualifiedBeta.passesUniverse).toBe(true);
    expect(qualifiedBeta.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bullish");
    expect(qualifiedBeta.longCallDecision).toBe("Strong Long Call Candidate");
  });

  it("fails the institutional beta filter on a genuinely negative beta instead of treating it as unavailable", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const result = gradeSetup({
      symbol: "NEGBETA",
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("NEGBETA"),
        beta: -0.5
      },
      optionable: true,
      options: demoOptions("NEGBETA", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      strictFundamentals: false,
      ...institutionalSetupContext()
    });

    expect(result.passesUniverse).toBe(false);
    expect(result.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bearish");
  });

  it("gates stock liquidity on average dollar volume alone, same as ETFs", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (avgShareVolume: number, avgDollarVolume20d: number) => gradeSetup({
      symbol: "LIQUIDITY" + avgShareVolume + avgDollarVolume20d,
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("LIQUIDITY" + avgShareVolume + avgDollarVolume20d),
        avgShareVolume,
        avgDollarVolume20d
      },
      optionable: true,
      options: [option("LIQUIDITY" + avgShareVolume + avgDollarVolume20d, 45, 500, 200, 0.55, 4, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    const belowThreshold = resultFor(50_000_000, 299_999_999);
    const atThreshold = resultFor(100_000, 300_000_000);

    expect(belowThreshold.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bearish");
    expect(atThreshold.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bullish");
  });

  it("keeps the $2B stock market-cap minimum", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (marketCap: number) => gradeSetup({
      symbol: "MARKETCAP" + marketCap,
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("MARKETCAP" + marketCap),
        marketCap
      },
      optionable: true,
      options: [option("MARKETCAP" + marketCap, 45, 500, 200, 0.55, 4, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    expect(resultFor(1_999_999_999).passesUniverse).toBe(false);
    expect(resultFor(2_000_000_000).passesUniverse).toBe(true);
  });

  it("ranks only 14-180 DTE swing calls and prefers 14-90 when quality is comparable", () => {
    const ranked = rankCallOptions([
      option("TOO-SHORT", 13, 900, 900, 0.55, 2, 102),
      option("SHORT", 14, 500, 200, 0.55, 4, 102),
      option("PREFERRED", 45, 500, 200, 0.55, 4, 102),
      option("LONGER", 120, 500, 200, 0.55, 4, 102),
      option("TOO-LONG", 220, 900, 900, 0.55, 2, 102)
    ], 100);

    expect(ranked.map((contract) => contract.symbol)).toEqual(["SHORT", "PREFERRED", "LONGER"]);
    expect(ranked.every((contract) => contract.dte !== undefined && contract.dte >= 14 && contract.dte <= 180)).toBe(true);
  });

  it("uses option spread bands for options market context", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (spreadPct: number) => gradeSetup({
      symbol: "SPREAD" + spreadPct,
      candles,
      currentPrice: price,
      fundamentals: strongFundamentals("SPREAD" + spreadPct),
      optionable: true,
      options: [option("SPREAD" + spreadPct, 45, 500, 200, 0.55, spreadPct, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    const ten = resultFor(10);
    const fifteen = resultFor(15);
    const sixteen = resultFor(16);

    expect(optionLayer(ten)?.status).toBe("Bullish");
    expect(optionLayer(ten)?.detail).toBe("Best call spread is 10.0%, inside the 10% institutional-quality threshold.");
    expect(optionLayer(fifteen)?.status).toBe("Bearish");
    expect(optionLayer(fifteen)?.detail).toBe("No preferred call spread at or below 10% was found; best usable spread is 15.0%.");
    expect(fifteen.longCallDecision).toBe("Avoid");
    expect(fifteen.suggestedOptions).toHaveLength(1);
    expect(optionLayer(sixteen)?.status).toBe("Bearish");
    expect(optionLayer(sixteen)?.detail).toBe("No call contract met the 15% maximum spread.");
    expect(sixteen.longCallDecision).toBe("Avoid");
    expect(sixteen.suggestedOptions).toEqual([]);
  });

  it("allows 91-180 DTE when contract quality is meaningfully better", () => {
    const ranked = rankCallOptions([
      option("WEAK-60", 60, 60, 25, 0.42, 18, 103),
      option("STRONG-150", 150, 2000, 600, 0.55, 3, 103)
    ], 100);

    expect(ranked[0].symbol).toBe("STRONG-150");
  });

  it("filters calls wider than the 15% maximum spread", () => {
    const ranked = rankCallOptions([
      option("WIDE", 45, 500, 200, 0.55, 16, 102),
      option("MAX", 45, 500, 200, 0.55, 15, 102)
    ], 100);

    expect(ranked.map((contract) => contract.symbol)).toEqual(["MAX"]);
  });

  it("requires tighter option open interest or volume", () => {
    const ranked = rankCallOptions([
      option("THIN", 45, 99, 24, 0.55, 4, 102),
      option("OI-PASS", 45, 100, 0, 0.55, 4, 102),
      option("VOL-PASS", 45, 0, 25, 0.55, 4, 102)
    ], 100);

    expect(ranked.map((contract) => contract.symbol).sort()).toEqual(["OI-PASS", "VOL-PASS"]);
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
    const close = index < 140 ? 100 + index * 0.35 : 149 + (index - 140) * 0.04 + Math.sin(index / 2) * 0.08;
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
    sectorCandles: activeDailySqueezeCandles(),
    spyCandles: activeDailySqueezeCandles(),
    qqqCandles: activeDailySqueezeCandles()
  };
}

function bearishMarketCandles(): Candle[] {
  return Array.from({ length: 180 }, (_, index) => {
    const close = 220 - index * 0.4;
    return {
      date: "2026-01-" + String(index + 1).padStart(2, "0"),
      open: close + 0.1,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 25_000_000
    };
  });
}

function bearishMacroRegime(): MacroRegimeContext {
  return {
    spy: { trend: "bearish", regime: "bearish", detail: "SPY trend is bearish." },
    qqq: { trend: "bearish", regime: "bearish", detail: "QQQ trend is bearish." },
    vix: { level: 18, regime: "rising", detail: "VIX at 18.00 is between 15 and 25 (rising)." },
    effectiveRegime: "bearish",
    detail: "SPY regime bearish (bearish trend); QQQ regime bearish (bearish trend); VIX rising; effective regime bearish.",
    warnings: []
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
    nextEarningsDate: futureDate(45)
  };
}

function preferredEntryPrice(indicators: ReturnType<typeof latestIndicators>): number {
  return (indicators.ema21 * 1.001 + indicators.ema8 * 0.999) / 2;
}

function optionLayer(result: ReturnType<typeof gradeSetup>) {
  return result.layerEvaluations.find((item) => item.layer === "Options Market Context");
}

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function weeklyIndicator(bias: "bullish" | "bearish" | "neutral", squeezeState: SqueezeState = "none") {
  const emaValues = bias === "bullish"
    ? { ema8: 120, ema21: 115, ema34: 110, ema50: 108, ema55: 105, ema89: 100, ema100: 98 }
    : bias === "bearish"
      ? { ema8: 160, ema21: 161, ema34: 162, ema50: 163, ema55: 164, ema89: 165, ema100: 166 }
      : { ema8: 120, ema21: 121, ema34: 110, ema50: 108, ema55: 105, ema89: 100, ema100: 98 };
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

function weeklyProximityIndicator(price: number, atrDistance: number) {
  const atr14 = 8;
  const ema21 = price - atr14 * atrDistance;
  return {
    ...weeklyIndicator("neutral"),
    ema8: ema21 - 1,
    ema21,
    ema34: ema21 - 2,
    ema50: ema21 - 3,
    ema55: ema21 - 4,
    ema89: ema21 - 5,
    ema100: ema21 - 6,
    atr14
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
    ema50: 101.5,
    ema55: 101,
    ema89: 100,
    ema100: 99,
    positiveEmaStack: true,
    priceAboveEmaStack: true,
    atr14: 3,
    atrDistanceFromEma21: withinOneAtrOfEma21 ? 0.67 : 2.33,
    withinOneAtrOfEma21,
    percentAboveEma21: withinOneAtrOfEma21 ? 1.94 : 6.8,
    withinTwoPercentOfEma21: withinOneAtrOfEma21,
    percentAboveEma50: withinOneAtrOfEma21 ? 3.45 : 8.37,
    percentBelowEma8: withinOneAtrOfEma21 ? 0.96 : -5.77,
    withinEmaPocket: withinOneAtrOfEma21,
    compressionScore: squeezeState === "none" ? 60 : 85,
    compressionStatus: squeezeState === "none" ? "Neutral" : "Bullish",
    squeezeState,
    detail: timeframe + " is bullish and " + (withinOneAtrOfEma21 ? "inside" : "outside") + " the EMA pocket."
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
    ema50: 99.5,
    ema55: 100,
    ema89: 101,
    ema100: 102,
    positiveEmaStack: false,
    priceAboveEmaStack: false,
    atr14: 3,
    atrDistanceFromEma21: -0.67,
    withinOneAtrOfEma21: false,
    percentAboveEma21: -2.04,
    withinTwoPercentOfEma21: false,
    percentAboveEma50: -3.52,
    percentBelowEma8: 1.03,
    withinEmaPocket: false,
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
    ema50: 101.5,
    ema55: 101,
    ema89: 100,
    ema100: 99,
    positiveEmaStack: false,
    priceAboveEmaStack: true,
    atr14: 3,
    atrDistanceFromEma21: 0.33,
    withinOneAtrOfEma21: true,
    percentAboveEma21: 0.96,
    withinTwoPercentOfEma21: true,
    percentAboveEma50: 3.45,
    percentBelowEma8: -1.94,
    withinEmaPocket: false,
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
