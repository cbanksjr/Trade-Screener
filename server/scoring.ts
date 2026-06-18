import type { Candle, Fundamentals, Grade, IndicatorSnapshot, LowerTimeframeConfluence, LowerTimeframeContext, OptionContract, ScanResult, ScoreRule, SqueezeState } from "../shared/types";
import { latestIndicators, round } from "./indicators";

const ATR_DISTANCE_LIMIT = 1.25;
const SQUEEZE_STATES: SqueezeState[] = ["low", "mid", "high"];

export const defaultSettings = {
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
  currentPrice?: number;
  fundamentals?: Fundamentals;
  optionable: boolean;
  options: OptionContract[];
  lowerTimeframes?: LowerTimeframeConfluence;
  lowerTimeframeWarnings?: string[];
  weeklyIndicators?: IndicatorSnapshot;
  weeklySqueezeWarning?: string;
  strictFundamentals?: boolean;
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = input.currentPrice ?? latest.close;
  const beta = input.fundamentals?.beta;
  const marketCap = input.fundamentals?.marketCap;
  const avgDollarVolume20d = input.fundamentals?.avgDollarVolume20d ?? average(input.candles.slice(-20).map((candle) => candle.volume * candle.close));
  const betaPassed = input.strictFundamentals ? beta !== undefined && beta >= defaultSettings.minBeta : true;
  const marketCapPassed = input.strictFundamentals ? marketCap !== undefined && marketCap >= defaultSettings.minMarketCap : true;
  const lowerTimeframes = input.lowerTimeframes ?? unavailableLowerTimeframes();
  const weeklyIndicators = input.weeklyIndicators;
  const commonRules: ScoreRule[] = [
    rule("optionable", "Optionable stock", input.optionable, 10, input.optionable ? "Options chain is available." : "No usable options chain was found."),
    rule("price", "Price above $20", price > defaultSettings.minPrice, 8, "Last price is $" + price.toFixed(2) + "."),
    rule("beta", "Beta >= 0.75", betaPassed, 8, beta !== undefined ? "Beta is " + beta.toFixed(2) + "." : input.strictFundamentals ? "Beta was not available from Schwab/fundamentals." : "Assumed prequalified by the selected universe."),
    rule("market-cap", "Market cap >= $2B", marketCapPassed, 8, marketCap !== undefined ? "Market cap is " + formatMoney(marketCap) + "." : input.strictFundamentals ? "Market cap was not available from Schwab/fundamentals." : "Assumed prequalified by the selected universe."),
    rule("dollar-volume", "20-day dollar volume >= $600M", avgDollarVolume20d >= defaultSettings.minAvgDollarVolume, 10, "20-day average dollar volume is " + formatMoney(avgDollarVolume20d) + ".")
  ];
  const selected = longCandidate(commonRules, input.options, price, indicators, lowerTimeframes);
  const passesUniverse = commonRules.every((item) => item.passed);
  const warnings = input.lowerTimeframeWarnings ?? (input.lowerTimeframes ? [] : ["Lower-timeframe confluence unavailable; 1h/4h rules were not scored."]);
  if (input.weeklySqueezeWarning) warnings.push(input.weeklySqueezeWarning);

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
    grade: toGrade(selected.score / selected.maxScore, isSqueezeActive(indicators.squeezeState)),
    score: selected.score,
    maxScore: selected.maxScore,
    indicators,
    weeklyIndicators,
    lowerTimeframes,
    rules: selected.rules,
    suggestedOptions: selected.options.slice(0, 5),
    candles: input.candles.slice(-90),
    lastUpdated: new Date().toISOString(),
    warnings
  };
}

function longCandidate(
  commonRules: ScoreRule[],
  options: OptionContract[],
  price: number,
  indicators: ReturnType<typeof latestIndicators>,
  lowerTimeframes: LowerTimeframeConfluence
): { direction: "long"; rules: ScoreRule[]; options: OptionContract[]; score: number; maxScore: number } {
  const directionalOptions = options.filter((contract) => contract.optionType === "call");
  const liquidOptions = directionalOptions.filter((contract) => contract.score >= 70);
  const atrDistance = indicators.atr14 > 0 ? round(Math.abs(price - indicators.ema21) / indicators.atr14, 2) : 0;
  const signedAtrDistance = indicators.atr14 > 0 ? round((price - indicators.ema21) / indicators.atr14, 2) : 0;
  const withinLongAtr = price >= indicators.ema21 && price <= indicators.ema21 + indicators.atr14 * ATR_DISTANCE_LIMIT;
  const rules = [
    ...commonRules,
    rule(
      "ema-stack",
      "Long: 21 EMA above 50 EMA",
      indicators.ema21 > indicators.ema50,
      14,
      "21 EMA " + indicators.ema21 + " vs 50 EMA " + indicators.ema50 + "."
    ),
    rule(
      "price-side",
      "Long: price above 21 EMA",
      price > indicators.ema21,
      8,
      "Price is $" + price.toFixed(2) + " vs 21 EMA " + indicators.ema21 + "."
    ),
    rule(
      "near-ema",
      "Long: price within +1.25 ATR of 21 EMA",
      withinLongAtr,
      14,
      "Price is " + atrDistance + " ATR from the 21 EMA (" + signedAtrDistance + " signed ATR). Limit is +" + ATR_DISTANCE_LIMIT + " ATR."
    ),
    confluenceRule("1h-confluence", "1h confluence", lowerTimeframes.oneHour),
    confluenceRule("4h-confluence", "4h confluence", lowerTimeframes.fourHour),
    rule("daily-squeeze", "Daily squeeze active", isSqueezeActive(indicators.squeezeState), 12, "Daily squeeze state is " + indicators.squeezeState + "."),
    rule(
      "momentum",
      "Squeeze histogram above zero",
      indicators.momentum > 0,
      10,
      "Momentum histogram is " + indicators.momentum + "."
    ),
    rule(
      "contracts",
      "Liquid call candidates",
      liquidOptions.length > 0,
      6,
      liquidOptions.length ? liquidOptions.length + " liquid call candidate(s) found." : "No liquid calls met the spread/open-interest filters."
    )
  ];
  const maxScore = rules.reduce((sum, item) => sum + item.maxPoints, 0);
  const score = rules.reduce((sum, item) => sum + item.points, 0);
  return { direction: "long", rules, options: directionalOptions.sort((a, b) => b.score - a.score), score, maxScore };
}

export function isSqueezeActive(state: SqueezeState | undefined): boolean {
  return Boolean(state && SQUEEZE_STATES.includes(state));
}

function confluenceRule(id: string, label: string, context: LowerTimeframeContext): ScoreRule {
  const expected = "bullish";
  return rule(
    id,
    label,
    context.bias === expected,
    6,
    context.bias === expected ? context.detail : context.detail + " Expected " + expected + " lower-timeframe confluence."
  );
}

function unavailableLowerTimeframes(): LowerTimeframeConfluence {
  const detail = "No lower-timeframe candles were available.";
  return {
    oneHour: { timeframe: "1h", bias: "unavailable", price: null, ema21: null, ema50: null, squeezeState: "none", detail },
    fourHour: { timeframe: "4h", bias: "unavailable", price: null, ema21: null, ema50: null, squeezeState: "none", detail }
  };
}

function rule(id: string, label: string, passed: boolean, maxPoints: number, detail: string): ScoreRule {
  return { id, label, passed, maxPoints, points: passed ? maxPoints : 0, detail };
}

function toGrade(ratio: number, hasDailySqueeze: boolean): Grade {
  if (ratio >= 0.97) return hasDailySqueeze ? "A+" : "A";
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
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}
