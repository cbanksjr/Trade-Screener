import type { Candle, Fundamentals, Grade, OptionContract, ScanResult, ScoreRule, TradeDirection } from "../shared/types";
import { latestIndicators, round } from "./indicators";

export const defaultSettings = {
  scanMode: "auto" as const,
  symbols: ["AAPL", "MSFT", "NVDA", "META", "AMD", "AMZN", "GOOGL", "TSLA"],
  minPrice: 20,
  minBeta: 0.75,
  minMarketCap: 2_000_000_000,
  minAvgDollarVolume: 600_000_000,
  useDemoDataWhenMissingApi: true
};

export function gradeSetup(input: {
  symbol: string;
  companyName?: string;
  candles: Candle[];
  fundamentals?: Fundamentals;
  optionable: boolean;
  options: OptionContract[];
  strictFundamentals?: boolean;
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = latest.close;
  const beta = input.fundamentals?.beta;
  const marketCap = input.fundamentals?.marketCap;
  const avgDollarVolume20d = input.fundamentals?.avgDollarVolume20d ?? average(input.candles.slice(-20).map((candle) => candle.volume * candle.close));
  const betaPassed = input.strictFundamentals ? beta !== undefined && beta >= defaultSettings.minBeta : true;
  const marketCapPassed = input.strictFundamentals ? marketCap !== undefined && marketCap >= defaultSettings.minMarketCap : true;
  const commonRules: ScoreRule[] = [
    rule("optionable", "Optionable stock", input.optionable, 10, input.optionable ? "Options chain is available." : "No usable options chain was found."),
    rule("price", "Price above $20", price > defaultSettings.minPrice, 8, `Last close is $${price.toFixed(2)}.`),
    rule("beta", "Beta >= 0.75", betaPassed, 8, beta !== undefined ? `Beta is ${beta.toFixed(2)}.` : input.strictFundamentals ? "Beta was not available from Schwab/fundamentals." : "Assumed prequalified by the selected universe."),
    rule("market-cap", "Market cap >= $2B", marketCapPassed, 8, marketCap !== undefined ? `Market cap is ${formatMoney(marketCap)}.` : input.strictFundamentals ? "Market cap was not available from Schwab/fundamentals." : "Assumed prequalified by the selected universe."),
    rule("dollar-volume", "20-day dollar volume >= $600M", avgDollarVolume20d >= defaultSettings.minAvgDollarVolume, 10, `20-day average dollar volume is ${formatMoney(avgDollarVolume20d)}.`)
  ];
  const candidates = [
    directionalCandidate("long", commonRules, input.options, price, indicators),
    directionalCandidate("short", commonRules, input.options, price, indicators)
  ];
  const selected = candidates.sort((a, b) => b.score / b.maxScore - a.score / a.maxScore)[0];
  const passesUniverse = commonRules.every((item) => item.passed);

  return {
    symbol: input.symbol,
    companyName: input.companyName,
    setupDirection: selected.direction,
    dataSource: "demo",
    price,
    beta: beta ?? null,
    marketCap: marketCap ?? null,
    avgDollarVolume20d: round(avgDollarVolume20d, 0),
    optionable: input.optionable,
    passesUniverse,
    grade: toGrade(selected.score / selected.maxScore),
    score: selected.score,
    maxScore: selected.maxScore,
    indicators,
    rules: selected.rules,
    suggestedOptions: selected.options.slice(0, 5),
    candles: input.candles.slice(-90),
    lastUpdated: new Date().toISOString(),
    warnings: []
  };
}

function directionalCandidate(
  direction: TradeDirection,
  commonRules: ScoreRule[],
  options: OptionContract[],
  price: number,
  indicators: ReturnType<typeof latestIndicators>
): { direction: TradeDirection; rules: ScoreRule[]; options: OptionContract[]; score: number; maxScore: number } {
  const isLong = direction === "long";
  const directionalOptions = options.filter((contract) => contract.optionType === (isLong ? "call" : "put"));
  const liquidOptions = directionalOptions.filter((contract) => contract.score >= 70);
  const atrDistance = indicators.atr14 > 0 ? round(Math.abs(price - indicators.ema21) / indicators.atr14, 2) : 0;
  const signedAtrDistance = indicators.atr14 > 0 ? round((price - indicators.ema21) / indicators.atr14, 2) : 0;
  const withinLongAtr = price >= indicators.ema21 && price <= indicators.ema21 + indicators.atr14;
  const withinShortAtr = price <= indicators.ema21 && price >= indicators.ema21 - indicators.atr14;
  const rules = [
    ...commonRules,
    rule(
      "ema-stack",
      isLong ? "Long: 21 EMA above 50 EMA" : "Short: 21 EMA below 50 EMA",
      isLong ? indicators.ema21 > indicators.ema50 : indicators.ema21 < indicators.ema50,
      14,
      `21 EMA ${indicators.ema21} vs 50 EMA ${indicators.ema50}.`
    ),
    rule(
      "price-side",
      isLong ? "Long: price above 21 EMA" : "Short: price below 21 EMA",
      isLong ? price > indicators.ema21 : price < indicators.ema21,
      8,
      `Price is $${price.toFixed(2)} vs 21 EMA ${indicators.ema21}.`
    ),
    rule(
      "near-ema",
      isLong ? "Long: price within +1 ATR of 21 EMA" : "Short: price within -1 ATR of 21 EMA",
      isLong ? withinLongAtr : withinShortAtr,
      14,
      `Price is ${atrDistance} ATR from the 21 EMA (${signedAtrDistance} signed ATR).`
    ),
    rule("squeeze", "Squeeze active or releasing", ["low", "mid", "high", "released"].includes(indicators.squeezeState), 12, `Current squeeze state is ${indicators.squeezeState}.`),
    rule(
      "momentum",
      isLong ? "Squeeze histogram above zero" : "Squeeze histogram below zero",
      isLong ? indicators.momentum > 0 : indicators.momentum < 0,
      10,
      `Momentum histogram is ${indicators.momentum}.`
    ),
    rule(
      "contracts",
      isLong ? "Liquid call candidates" : "Liquid put candidates",
      liquidOptions.length > 0,
      6,
      liquidOptions.length ? `${liquidOptions.length} liquid ${isLong ? "call" : "put"} candidate(s) found.` : `No liquid ${isLong ? "calls" : "puts"} met the spread/open-interest filters.`
    )
  ];
  const maxScore = rules.reduce((sum, item) => sum + item.maxPoints, 0);
  const score = rules.reduce((sum, item) => sum + item.points, 0);
  return { direction, rules, options: directionalOptions.sort((a, b) => b.score - a.score), score, maxScore };
}

function rule(id: string, label: string, passed: boolean, maxPoints: number, detail: string): ScoreRule {
  return { id, label, passed, maxPoints, points: passed ? maxPoints : 0, detail };
}

function toGrade(ratio: number): Grade {
  if (ratio >= 0.97) return "A+";
  if (ratio >= 0.9) return "A";
  if (ratio >= 0.8) return "B";
  if (ratio >= 0.7) return "C";
  if (ratio >= 0.6) return "D";
  return "F";
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
}
