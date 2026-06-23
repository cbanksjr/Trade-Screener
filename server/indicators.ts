import type { Candle, IndicatorSnapshot, SqueezeState } from "../shared/types";

export function ema(values: number[], period: number): number[] {
  const multiplier = 2 / (period + 1);
  const output: number[] = [];
  values.forEach((value, index) => {
    if (index === 0) output.push(value);
    else output.push(value * multiplier + output[index - 1] * (1 - multiplier));
  });
  return output;
}

export function sma(values: number[], period: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const slice = values.slice(start, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

export function standardDeviation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function atr(candles: Candle[], period = 14): number[] {
  return ema(trueRanges(candles), period);
}

export function trueRanges(candles: Candle[]): number[] {
  return candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
}

export function latestIndicators(candles: Candle[]): IndicatorSnapshot {
  if (candles.length < 90) {
    throw new Error("At least 90 candles are required to calculate the compression setup.");
  }

  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const ema8Series = ema(closes, 8);
  const ema21Series = ema(closes, 21);
  const ema34Series = ema(closes, 34);
  const ema50Series = ema(closes, 50);
  const ema55Series = ema(closes, 55);
  const ema89Series = ema(closes, 89);
  const ema100Series = ema(closes, 100);
  const atr14Series = atr(candles, 14);
  const index = candles.length - 1;
  const squeezePeriod = 20;
  const basis = sma(closes, 20)[index];
  const recentCloses = closes.slice(-squeezePeriod);
  const deviation = standardDeviation(recentCloses);
  const latestAtr = atr14Series[index];
  const kcBasis = basis;
  const kcRange = sma(trueRanges(candles), squeezePeriod)[index];
  const bbUpper = basis + deviation * 2;
  const bbLower = basis - deviation * 2;
  const previousBasis = sma(closes.slice(0, -5), 20).at(-1) ?? basis;
  const previousDeviation = standardDeviation(closes.slice(-squeezePeriod - 5, -5));
  const previousBbWidth = previousBasis ? ((previousBasis + previousDeviation * 2) - (previousBasis - previousDeviation * 2)) / previousBasis : 0;
  const bbWidth = basis ? (bbUpper - bbLower) / basis : 0;
  const kcLowUpper = kcBasis + kcRange * 2;
  const kcLowLower = kcBasis - kcRange * 2;
  const kcMidUpper = kcBasis + kcRange * 1.5;
  const kcMidLower = kcBasis - kcRange * 1.5;
  const kcHighUpper = kcBasis + kcRange;
  const kcHighLower = kcBasis - kcRange;
  const momentum = linearMomentum(closes, highs, lows, 20);
  const previousMomentum = linearMomentum(closes.slice(0, -5), highs.slice(0, -5), lows.slice(0, -5), 20);
  const recentAtr = average(atr14Series.slice(-5));
  const priorAtr = average(atr14Series.slice(-15, -5));
  const recentRange = average(candles.slice(-5).map((candle) => candle.high - candle.low));
  const priorRange = average(candles.slice(-15, -5).map((candle) => candle.high - candle.low));

  return {
    ema8: round(ema8Series[index]),
    ema21: round(ema21Series[index]),
    ema34: round(ema34Series[index]),
    ema50: round(ema50Series[index]),
    ema55: round(ema55Series[index]),
    ema89: round(ema89Series[index]),
    ema100: round(ema100Series[index]),
    atr14: round(latestAtr),
    atrContracting: recentAtr <= priorAtr,
    bbUpper: round(bbUpper),
    bbLower: round(bbLower),
    bbWidth: round(bbWidth * 100, 2),
    bbContracting: bbWidth <= previousBbWidth,
    kcLowUpper: round(kcLowUpper),
    kcLowLower: round(kcLowLower),
    kcMidUpper: round(kcMidUpper),
    kcMidLower: round(kcMidLower),
    kcHighUpper: round(kcHighUpper),
    kcHighLower: round(kcHighLower),
    momentum: round(momentum),
    momentumImproving: momentum >= previousMomentum,
    candleRangeContracting: recentRange <= priorRange,
    squeezeState: squeezeState(
      bbUpper,
      bbLower,
      kcLowUpper,
      kcLowLower,
      kcMidUpper,
      kcMidLower,
      kcHighUpper,
      kcHighLower
    )
  };
}

export function activeSqueezeDotCount(candles: Candle[]): number {
  let count = 0;
  for (let end = candles.length; end >= 90; end -= 1) {
    if (!isActiveSqueeze(latestIndicators(candles.slice(0, end)).squeezeState)) break;
    count += 1;
  }
  return count;
}

function isActiveSqueeze(state: SqueezeState): boolean {
  return state === "low" || state === "mid" || state === "high";
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function squeezeState(
  bbUpper: number,
  bbLower: number,
  kcLowUpper: number,
  kcLowLower: number,
  kcMidUpper: number,
  kcMidLower: number,
  kcHighUpper: number,
  kcHighLower: number
): SqueezeState {
  if (isInsideChannel(bbUpper, bbLower, kcHighUpper, kcHighLower)) return "high";
  if (isInsideChannel(bbUpper, bbLower, kcMidUpper, kcMidLower)) return "mid";
  if (isInsideChannel(bbUpper, bbLower, kcLowUpper, kcLowLower)) return "low";
  if (bbUpper > kcLowUpper || bbLower < kcLowLower) return "released";
  return "none";
}

function isInsideChannel(bbUpper: number, bbLower: number, kcUpper: number, kcLower: number): boolean {
  return bbUpper <= kcUpper && bbLower >= kcLower;
}

function linearMomentum(closes: number[], highs: number[], lows: number[], period: number): number {
  const closeSlice = closes.slice(-period);
  const highSlice = highs.slice(-period);
  const lowSlice = lows.slice(-period);
  const high = Math.max(...highSlice);
  const low = Math.min(...lowSlice);
  const mean = ((high + low) / 2 + closeSlice.reduce((sum, close) => sum + close, 0) / closeSlice.length) / 2;
  return closeSlice[closeSlice.length - 1] - mean;
}

export function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}
