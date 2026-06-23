import type { AnalysisTimeframe, Candle, LayerStatus, LowerTimeframeConfluence, LowerTimeframeContext, TimeframeBias } from "../shared/types";
import { latestIndicators } from "./indicators";

export function buildLowerTimeframeConfluence(thirtyMinuteCandles: Candle[]): LowerTimeframeConfluence {
  const oneHourCandles = aggregateSequentialCandles(thirtyMinuteCandles, 2, { includeIncomplete: false });
  const fourHourCandles = aggregateSequentialCandles(thirtyMinuteCandles, 8, { includeIncomplete: false });
  return {
    thirtyMinute: buildContext("30m", thirtyMinuteCandles),
    oneHour: buildContext("1h", oneHourCandles),
    fourHour: buildContext("4h", fourHourCandles)
  };
}

export function aggregateSequentialCandles(candles: Candle[], candlesPerBar: number, options: { includeIncomplete?: boolean } = {}): Candle[] {
  const includeIncomplete = options.includeIncomplete ?? true;
  const bySession = new Map<string, Candle[]>();
  for (const candle of candles.filter((item) => Number.isFinite(new Date(item.date).getTime())).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
    const session = new Date(candle.date).toISOString().slice(0, 10);
    bySession.set(session, [...(bySession.get(session) ?? []), candle]);
  }

  const output: Candle[] = [];
  for (const sessionCandles of bySession.values()) {
    for (let index = 0; index < sessionCandles.length; index += candlesPerBar) {
      const group = sessionCandles.slice(index, index + candlesPerBar);
      if (!includeIncomplete && group.length < candlesPerBar) continue;
      if (!group.length) continue;
      output.push({
        date: group[0].date,
        open: group[0].open,
        high: Math.max(...group.map((candle) => candle.high)),
        low: Math.min(...group.map((candle) => candle.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((sum, candle) => sum + candle.volume, 0)
      });
    }
  }
  return output;
}

export function buildTimeframeContext(timeframe: AnalysisTimeframe, candles: Candle[]): LowerTimeframeContext {
  return buildContext(timeframe, candles);
}

function buildContext(timeframe: AnalysisTimeframe, candles: Candle[]): LowerTimeframeContext {
  if (candles.length < 90) {
    return {
      timeframe,
      bias: "unavailable",
      price: null,
      ema8: null,
      ema21: null,
      ema34: null,
      ema50: null,
      ema55: null,
      ema89: null,
      ema100: null,
      positiveEmaStack: false,
      priceAboveEmaStack: false,
      atr14: null,
      atrDistanceFromEma21: null,
      withinOneAtrOfEma21: false,
      percentAboveEma21: null,
      withinTwoPercentOfEma21: false,
      compressionScore: 0,
      compressionStatus: "Insufficient Data",
      squeezeState: "none",
      detail: timeframe + " needs at least 90 candles; only " + candles.length + " were available."
    };
  }

  const indicators = latestIndicators(candles);
  const price = candles[candles.length - 1].close;
  const positiveEmaStack = hasPositiveEmaStack(indicators);
  const priceAboveEmaStack = price >= indicators.ema21
    && price > indicators.ema50
    && price > indicators.ema100;
  const atrDistanceFromEma21 = indicators.atr14 > 0 ? (price - indicators.ema21) / indicators.atr14 : Number.POSITIVE_INFINITY;
  const percentAboveEma21 = indicators.ema21 > 0 ? ((price - indicators.ema21) / indicators.ema21) * 100 : Number.POSITIVE_INFINITY;
  const withinTwoPercentOfEma21 = percentAboveEma21 >= 0 && percentAboveEma21 <= 2;
  const compressionScore = compressionQualityScore(indicators, priceAboveEmaStack);
  const compressionStatus = compressionLayerStatus(compressionScore, indicators.squeezeState);
  const bias = lowerTimeframeBias(positiveEmaStack, priceAboveEmaStack);
  return {
    timeframe,
    bias,
    price,
    ema8: indicators.ema8,
    ema21: indicators.ema21,
    ema34: indicators.ema34,
    ema50: indicators.ema50,
    ema55: indicators.ema55,
    ema89: indicators.ema89,
    ema100: indicators.ema100,
    positiveEmaStack,
    priceAboveEmaStack,
    atr14: indicators.atr14,
    atrDistanceFromEma21: round(atrDistanceFromEma21),
    withinOneAtrOfEma21: withinTwoPercentOfEma21,
    percentAboveEma21: round(percentAboveEma21),
    withinTwoPercentOfEma21,
    compressionScore,
    compressionStatus,
    squeezeState: indicators.squeezeState,
    detail: timeframe + " is " + bias + ": price $" + price.toFixed(2) + ", EMAs "
      + [indicators.ema8, indicators.ema21, indicators.ema50, indicators.ema100].join("/")
      + ", squeeze " + indicators.squeezeState
      + ", " + (withinTwoPercentOfEma21 ? "inside" : "outside")
      + " the 0-2% entry zone above the 21 EMA."
  };
}

function round(value: number, places = 2): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(places));
}

function lowerTimeframeBias(positiveEmaStack: boolean, priceAboveEmaStack: boolean): TimeframeBias {
  if (positiveEmaStack && priceAboveEmaStack) return "bullish";
  if (!positiveEmaStack && !priceAboveEmaStack) return "bearish";
  return "neutral";
}

export function hasPositiveEmaStack(indicators: {
  ema8: number;
  ema21: number;
  ema34: number;
  ema50: number;
  ema55: number;
  ema89: number;
  ema100: number;
}): boolean {
  return indicators.ema8 > indicators.ema21
    && indicators.ema21 > indicators.ema50
    && indicators.ema50 > indicators.ema100;
}

export function compressionQualityScore(indicators: {
  squeezeState?: string;
  atrContracting?: boolean;
  bbContracting?: boolean;
  candleRangeContracting?: boolean;
  momentumImproving?: boolean;
}, priceAboveEmaStack: boolean): number {
  let score = 0;
  if (indicators.squeezeState === "high") score += 30;
  else if (indicators.squeezeState === "mid") score += 25;
  else if (indicators.squeezeState === "low") score += 20;
  if (indicators.bbContracting) score += 20;
  if (indicators.atrContracting) score += 20;
  if (indicators.candleRangeContracting) score += 10;
  if (indicators.momentumImproving) score += 10;
  if (priceAboveEmaStack) score += 10;
  return Math.min(100, score);
}

export function compressionLayerStatus(score: number, squeezeState?: string): LayerStatus {
  if (!squeezeState || squeezeState === "none") return score >= 50 ? "Neutral" : "Bearish";
  if (squeezeState === "released") return "Conflicting";
  if (score >= 75) return "Bullish";
  if (score >= 55) return "Neutral";
  return "Conflicting";
}

export function aggregateDailyCandlesToWeeks(candles: Candle[]): Candle[] {
  const groups = new Map<string, Candle[]>();
  for (const candle of candles.filter((item) => Number.isFinite(new Date(item.date).getTime())).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
    const week = weekKey(candle.date);
    groups.set(week, [...(groups.get(week) ?? []), candle]);
  }

  return [...groups.values()].map((group) => ({
    date: group[0].date,
    open: group[0].open,
    high: Math.max(...group.map((candle) => candle.high)),
    low: Math.min(...group.map((candle) => candle.low)),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, candle) => sum + candle.volume, 0)
  }));
}

function weekKey(value: string): string {
  const date = new Date(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}
