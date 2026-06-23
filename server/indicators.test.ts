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
    expect(indicators.ema21).toBeGreaterThan(indicators.ema50);
    expect(indicators.ema50).toBeGreaterThan(indicators.ema100);
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

  it("requires at least 5 consecutive active daily squeeze dots", () => {
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
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(result.dailySqueezeDotCount).toBeLessThan(5);
    expect(result.longCallDecision).toBe("Avoid");
    expect(result.reasonsAgainstTrade.join(" ")).toContain("At least 5 consecutive active daily squeeze dots are required");
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

  it("avoids when daily qualifies but weekly context is unavailable", () => {
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

    expect(result.longCallDecision).toBe("Avoid");
  });

  it("calculates equal-weight institutional setup score factors", () => {
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

    expect(result.institutionalFactors).toHaveLength(7);
    expect(result.institutionalFactors.find((factor) => factor.status === "Bullish")?.contribution).toBeCloseTo(100 / 7);
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
      options: [option("LOWA", 45, 500, 200, 0.55, 15, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: returnCandles(100, 0.005),
      spyCandles: returnCandles(100, 0.01)
    });

    expect(result.setupScore).toBeLessThan(80);
    expect(result.longCallDecision).toBe("Watchlist Candidate");
    expect(result.grade).toBe("C");
    expect(result.gradeCapReasons).toContain("Setup score below 90.");
  });

  it("assigns B when a setup score lands in the 80-89 band", () => {
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
        avgDollarVolume20d: 900_000_000
      },
      optionable: true,
      options: demoOptions("HIGHCAP", price),
      weeklyIndicators: weeklyIndicator("bullish"),
      sector: "Information Technology",
      sectorCandles: activeDailySqueezeCandles(),
      spyCandles: activeDailySqueezeCandles(),
      qqqCandles: activeDailySqueezeCandles()
    });

    expect(result.setupScore).toBeGreaterThanOrEqual(80);
    expect(result.setupScore).toBeLessThan(90);
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.grade).toBe("B");
  });

  it("avoids high-score setups when weekly context is not bullish", () => {
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
    expect(result.longCallDecision).toBe("Avoid");
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

    expect(result.setupScore).toBeLessThan(80);
    expect(result.longCallDecision).toBe("Watchlist Candidate");
    expect(result.grade).toBe("C");
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
    expect(fiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
    expect(fiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Earnings are within 14 days.");
    expect(fourteenDay.longCallDecision).toBe("Avoid");
    expect(fourteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bearish");
    expect(fifteenDay.longCallDecision).not.toBe("Avoid");
    expect(fifteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Neutral");
    expect(fifteenDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Earnings are 15-29 days away; catalyst risk is elevated.");
    expect(twentyNineDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Neutral");
    expect(thirtyDay.longCallDecision).toBe("Strong Long Call Candidate");
    expect(thirtyDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
    expect(thirtyDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.detail).toBe("Next earnings is at least 30 days away.");
    expect(fortyFiveDay.longCallDecision).toBe("Strong Long Call Candidate");
    expect(fortyFiveDay.institutionalFactors.find((factor) => factor.name === "Catalyst Safety")?.status).toBe("Bullish");
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
    const volatilityFit = result.institutionalFactors.find((factor) => factor.name === "Volatility Fit");

    expect(typeof result.indicators.momentum).toBe("number");
    expect(typeof result.indicators.momentumImproving).toBe("boolean");
    expect(volatilityFit?.detail).toContain("momentum");
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

  it("allows entries from 0.1% above the 50 EMA through 0.1% below the 8 EMA", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const lowerPocketPrice = indicators.ema50 * 1.001;
    const upperPocketPrice = indicators.ema8 * 0.999;
    const resultAtLowerPocket = gradeSetup({
      symbol: "ABOVE50",
      candles,
      currentPrice: lowerPocketPrice,
      fundamentals: strongFundamentals("ABOVE50"),
      optionable: true,
      options: demoOptions("ABOVE50", lowerPocketPrice),
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
    expect(resultAtLowerPocket.suggestedEntryArea).toContain("0.1% above 50 EMA");
  });

  it("flags entries below the 50 EMA pocket or too close to the 8 EMA", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const belowPrice = indicators.ema50 * 1.0009;
    const extendedPrice = indicators.ema8 * 0.9991;
    const below = gradeSetup({
      symbol: "BELOW50POCKET",
      candles,
      currentPrice: belowPrice,
      fundamentals: strongFundamentals("BELOW50POCKET"),
      optionable: true,
      options: demoOptions("BELOW50POCKET", belowPrice),
      lowerTimeframes: bullishLowerTimeframes("none")
    });
    const extended = gradeSetup({
      symbol: "EXTENDED",
      candles,
      currentPrice: extendedPrice,
      fundamentals: strongFundamentals("EXTENDED"),
      optionable: true,
      options: demoOptions("EXTENDED", extendedPrice),
      lowerTimeframes: bullishLowerTimeframes("none")
    });

    expect(below.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinEmaPocket).toBe(false);
    expect(below.longCallDecision).toBe("Avoid");
    expect(extended.squeezeStatusByTimeframe.find((item) => item.timeframe === "daily")?.withinEmaPocket).toBe(false);
    expect(extended.longCallDecision).toBe("Avoid");
    expect(extended.reasonsAgainstTrade.join(" ")).toContain("Outside the EMA pocket");
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

  it("uses $300M as the average dollar volume liquidity threshold", () => {
    const candles = activeDailySqueezeCandles();
    const indicators = latestIndicators(candles);
    const price = preferredEntryPrice(indicators);
    const resultFor = (avgDollarVolume20d: number) => gradeSetup({
      symbol: "DOLLARVOL" + avgDollarVolume20d,
      candles,
      currentPrice: price,
      fundamentals: {
        ...strongFundamentals("DOLLARVOL" + avgDollarVolume20d),
        avgDollarVolume20d
      },
      optionable: true,
      options: [option("DOLLARVOL" + avgDollarVolume20d, 45, 500, 200, 0.55, 4, 102)],
      weeklyIndicators: weeklyIndicator("bullish"),
      ...institutionalSetupContext()
    });

    const under = resultFor(299_000_000);
    const exact = resultFor(300_000_000);

    expect(under.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Neutral");
    expect(under.institutionalFactors.find((factor) => factor.name === "Liquidity")?.status).toBe("Bearish");
    expect(exact.layerEvaluations.find((layer) => layer.layer === "Institutional Context")?.status).toBe("Bullish");
    expect(exact.institutionalFactors.find((factor) => factor.name === "Liquidity")?.status).toBe("Bullish");
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
    const twenty = resultFor(20);
    const twentyOne = resultFor(21);

    expect(optionLayer(ten)?.status).toBe("Bullish");
    expect(optionLayer(ten)?.detail).toBe("Best call spread is 10.0%, inside the 10% institutional-quality threshold.");
    expect(optionLayer(fifteen)?.status).toBe("Neutral");
    expect(optionLayer(fifteen)?.detail).toBe("Best call spread is 15.0%; usable but wider than the 10% institutional-quality threshold.");
    expect(optionLayer(twenty)?.status).toBe("Neutral");
    expect(optionLayer(twentyOne)?.status).toBe("Bearish");
    expect(optionLayer(twentyOne)?.detail).toBe("No call contract met the 20% maximum spread filter.");
    expect(twentyOne.longCallDecision).toBe("Avoid");
    expect(twentyOne.suggestedOptions).toEqual([]);
  });

  it("allows 91-180 DTE when contract quality is meaningfully better", () => {
    const ranked = rankCallOptions([
      option("WEAK-60", 60, 60, 25, 0.42, 18, 103),
      option("STRONG-150", 150, 2000, 600, 0.55, 3, 103)
    ], 100);

    expect(ranked[0].symbol).toBe("STRONG-150");
  });

  it("filters calls wider than the 20% maximum spread", () => {
    const ranked = rankCallOptions([
      option("WIDE", 45, 500, 200, 0.55, 21, 102),
      option("MAX", 45, 500, 200, 0.55, 20, 102)
    ], 100);

    expect(ranked.map((contract) => contract.symbol)).toEqual(["MAX"]);
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
  return (indicators.ema50 * 1.001 + indicators.ema8 * 0.999) / 2;
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
