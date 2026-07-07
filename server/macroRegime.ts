import type { Candle, MacroRegimeLabel, MacroTrendState, TradeDirection, VixRegime } from "../shared/types";
import { ema, MIN_CANDLES_REQUIRED, round } from "./indicators";

export const MACRO_TREND_EMA_FAST_PERIOD = 20;
export const MACRO_TREND_EMA_MID_PERIOD = 50;
export const MACRO_TREND_EMA_SLOW_PERIOD = 200;
export const VIX_LOW_MAX = 15;
export const VIX_ELEVATED_MIN = 25;
export const COUNTER_TREND_MODIFIER = 0.7;

export type IndexTrendSnapshot = {
  trend: MacroTrendState;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  price: number | null;
  detail: string;
};

export type IndexRegimeSnapshot = {
  trend: MacroTrendState;
  regime: MacroRegimeLabel;
  detail: string;
};

export type VixSnapshot = {
  level: number | null;
  regime: VixRegime;
  detail: string;
};

export type MacroRegimeContext = {
  spy: IndexRegimeSnapshot;
  qqq: IndexRegimeSnapshot;
  vix: VixSnapshot;
  effectiveRegime: MacroRegimeLabel;
  detail: string;
  warnings: string[];
};

export function classifyIndexTrend(candles: Candle[] | undefined, indexLabel: string): IndexTrendSnapshot {
  if (!candles || candles.length < MIN_CANDLES_REQUIRED) {
    return {
      trend: "neutral",
      ema20: null,
      ema50: null,
      ema200: null,
      price: null,
      detail: indexLabel + " daily history unavailable; trend treated as neutral."
    };
  }
  const closes = candles.map((candle) => candle.close);
  const ema20 = round(ema(closes, MACRO_TREND_EMA_FAST_PERIOD).at(-1) ?? NaN);
  const ema50 = round(ema(closes, MACRO_TREND_EMA_MID_PERIOD).at(-1) ?? NaN);
  const ema200 = round(ema(closes, MACRO_TREND_EMA_SLOW_PERIOD).at(-1) ?? NaN);
  const price = candles[candles.length - 1].close;
  const bullish = price > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearish = price < ema20 && ema20 < ema50 && ema50 < ema200;
  const trend: MacroTrendState = bullish ? "bullish" : bearish ? "bearish" : "neutral";
  return {
    trend,
    ema20,
    ema50,
    ema200,
    price,
    detail: indexLabel + " daily trend is " + trend + ": price $" + price.toFixed(2) + ", EMAs " + ema20 + "/" + ema50 + "/" + ema200 + "."
  };
}

export function classifyVixLevel(vixLevel: number | undefined): { regime: VixRegime; detail: string } {
  if (vixLevel === undefined || !Number.isFinite(vixLevel)) {
    return { regime: "low", detail: "VIX level unavailable; volatility regime defaulted to low/neutral." };
  }
  if (vixLevel < VIX_LOW_MAX) return { regime: "low", detail: "VIX at " + vixLevel.toFixed(2) + " is below " + VIX_LOW_MAX + " (low)." };
  if (vixLevel > VIX_ELEVATED_MIN) return { regime: "elevated", detail: "VIX at " + vixLevel.toFixed(2) + " is above " + VIX_ELEVATED_MIN + " (elevated)." };
  return { regime: "rising", detail: "VIX at " + vixLevel.toFixed(2) + " is between " + VIX_LOW_MAX + " and " + VIX_ELEVATED_MIN + " (rising)." };
}

export function combineIndexRegime(trend: MacroTrendState, vixRegime: VixRegime, indexLabel: string): IndexRegimeSnapshot {
  if (trend === "bearish") return { trend, regime: "bearish", detail: indexLabel + " trend is bearish." };
  if (trend === "neutral") return { trend, regime: "neutral", detail: indexLabel + " trend is neutral." };
  if (vixRegime === "elevated") return { trend, regime: "neutral", detail: indexLabel + " trend is bullish but elevated VIX downgrades the regime to neutral." };
  return { trend, regime: "bullish", detail: indexLabel + " trend is bullish with " + vixRegime + " volatility." };
}

const REGIME_SEVERITY: Record<MacroRegimeLabel, number> = { bearish: 0, neutral: 1, bullish: 2 };

export function moreBearishRegime(a: MacroRegimeLabel, b: MacroRegimeLabel): MacroRegimeLabel {
  return REGIME_SEVERITY[a] <= REGIME_SEVERITY[b] ? a : b;
}

export function computeMacroRegimeContext(input: {
  spyCandles?: Candle[];
  qqqCandles?: Candle[];
  vixLevel?: number;
}): MacroRegimeContext {
  const warnings: string[] = [];
  const spyTrend = classifyIndexTrend(input.spyCandles, "SPY");
  const qqqTrend = classifyIndexTrend(input.qqqCandles, "QQQ");
  if (!input.spyCandles?.length) warnings.push("SPY macro history unavailable; SPY trend treated as neutral.");
  if (!input.qqqCandles?.length) warnings.push("QQQ macro history unavailable; QQQ trend treated as neutral.");
  const vix = classifyVixLevel(input.vixLevel);
  if (input.vixLevel === undefined) warnings.push("VIX level unavailable; volatility regime treated as low/neutral for this scan.");
  const spy = combineIndexRegime(spyTrend.trend, vix.regime, "SPY");
  const qqq = combineIndexRegime(qqqTrend.trend, vix.regime, "QQQ");
  const effectiveRegime = moreBearishRegime(spy.regime, qqq.regime);
  const detail = "SPY regime " + spy.regime + " (" + spyTrend.trend + " trend); QQQ regime " + qqq.regime + " (" + qqqTrend.trend + " trend); VIX " + vix.regime + "; effective regime " + effectiveRegime + ".";
  return {
    spy,
    qqq,
    vix: { level: input.vixLevel ?? null, regime: vix.regime, detail: vix.detail },
    effectiveRegime,
    detail,
    warnings
  };
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function resolveMacroModifier(stockDirection: TradeDirection, effectiveRegime: MacroRegimeLabel): { modifier: number; counterTrend: boolean } {
  const aligned = stockDirection === "long"
    ? effectiveRegime !== "bearish"
    // Unreachable in this long-only codebase (ScanResult.setupDirection is hardcoded "long" in
    // server/scoring.ts) — kept only for correctness/documentation of the full 4-row modifier table.
    : effectiveRegime !== "bullish";
  return aligned ? { modifier: 1, counterTrend: false } : { modifier: COUNTER_TREND_MODIFIER, counterTrend: true };
}
