import type { Candle, Fundamentals, Grade, OptionContract, ScanResult, ScoreRule } from "../shared/types";
import { latestIndicators, round } from "./indicators";

export const defaultSettings = {
  scanMode: "universe" as const,
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
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = latest.close;
  const avgDollarVolume20d = input.fundamentals?.avgDollarVolume20d ?? average(input.candles.slice(-20).map((candle) => candle.volume * candle.close));
  const liquidOptions = input.options.filter((contract) => contract.score >= 70);
  const rules: ScoreRule[] = [
    rule("optionable", "Optionable stock", input.optionable, 10, input.optionable ? "Options chain is available." : "No usable options chain was found."),
    rule("price", "Price above $20", price > defaultSettings.minPrice, 8, `Last close is $${price.toFixed(2)}.`),
    rule("beta", "Beta prequalified", true, 8, input.fundamentals?.beta ? `Imported beta is ${input.fundamentals.beta.toFixed(2)}.` : "Assumed prequalified by imported watchlist."),
    rule("market-cap", "Market cap prequalified", true, 8, input.fundamentals?.marketCap ? `Imported market cap is ${formatMoney(input.fundamentals.marketCap)}.` : "Assumed prequalified by imported watchlist."),
    rule("dollar-volume", "20-day dollar volume >= $600M", avgDollarVolume20d >= defaultSettings.minAvgDollarVolume, 10, `20-day average dollar volume is ${formatMoney(avgDollarVolume20d)}.`),
    rule("ema-stack", "21 EMA above 50 EMA", indicators.ema21 > indicators.ema50, 14, `21 EMA ${indicators.ema21} vs 50 EMA ${indicators.ema50}.`),
    rule("near-ema", "Price within 1 ATR of 21 EMA", Math.abs(price - indicators.ema21) <= indicators.atr14, 14, `Price is ${round(Math.abs(price - indicators.ema21) / indicators.atr14, 2)} ATR from the 21 EMA.`),
    rule("squeeze", "Squeeze active or releasing", ["low", "mid", "high", "released"].includes(indicators.squeezeState), 12, `Current squeeze state is ${indicators.squeezeState}.`),
    rule("momentum", "Squeeze histogram above zero", indicators.momentum > 0, 10, `Momentum histogram is ${indicators.momentum}.`),
    rule("calls", "Liquid call candidates", liquidOptions.length > 0, 6, liquidOptions.length ? `${liquidOptions.length} liquid call candidate(s) found.` : "No liquid calls met the spread/open-interest filters.")
  ];

  const maxScore = rules.reduce((sum, item) => sum + item.maxPoints, 0);
  const score = rules.reduce((sum, item) => sum + item.points, 0);
  const grade = toGrade(score / maxScore);
  const passesUniverse = rules.slice(0, 5).every((item) => item.passed);

  return {
    symbol: input.symbol,
    companyName: input.companyName,
    dataSource: "demo",
    price,
    beta: input.fundamentals?.beta ?? null,
    marketCap: input.fundamentals?.marketCap ?? null,
    avgDollarVolume20d: round(avgDollarVolume20d, 0),
    optionable: input.optionable,
    passesUniverse,
    grade,
    score,
    maxScore,
    indicators,
    rules,
    suggestedOptions: input.options.slice(0, 5),
    candles: input.candles.slice(-90),
    lastUpdated: new Date().toISOString(),
    warnings: []
  };
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
