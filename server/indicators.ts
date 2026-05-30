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
  const trueRanges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return ema(trueRanges, period);
}

export function latestIndicators(candles: Candle[]): IndicatorSnapshot {
  if (candles.length < 50) {
    throw new Error("At least 50 candles are required to calculate the swing setup.");
  }

  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const ema21Series = ema(closes, 21);
  const ema50Series = ema(closes, 50);
  const atr14Series = atr(candles, 14);
  const index = candles.length - 1;
  const basis = sma(closes, 20)[index];
  const recentCloses = closes.slice(-20);
  const deviation = standardDeviation(recentCloses);
  const latestAtr = atr14Series[index];
  const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const kcBasis = ema(typical, 20)[index];
  const bbUpper = basis + deviation * 2;
  const bbLower = basis - deviation * 2;
  const kcLowUpper = kcBasis + latestAtr * 2;
  const kcLowLower = kcBasis - latestAtr * 2;
  const kcMidUpper = kcBasis + latestAtr * 1.5;
  const kcMidLower = kcBasis - latestAtr * 1.5;
  const kcHighUpper = kcBasis + latestAtr;
  const kcHighLower = kcBasis - latestAtr;
  const momentum = linearMomentum(closes, highs, lows, 20);

  return {
    ema21: round(ema21Series[index]),
    ema50: round(ema50Series[index]),
    atr14: round(latestAtr),
    bbUpper: round(bbUpper),
    bbLower: round(bbLower),
    kcLowUpper: round(kcLowUpper),
    kcLowLower: round(kcLowLower),
    kcMidUpper: round(kcMidUpper),
    kcMidLower: round(kcMidLower),
    kcHighUpper: round(kcHighUpper),
    kcHighLower: round(kcHighLower),
    momentum: round(momentum),
    squeezeState: squeezeState(bbUpper, bbLower, kcLowUpper, kcLowLower, kcMidUpper, kcMidLower, kcHighUpper, kcHighLower)
  };
}

function squeezeState(
  bbUpper: number,
  bbLower: number,
  kcLowUpper: number,
  kcLowLower: number,
  kcMidUpper: number,
  kcMidLower: number,
  kcHighUpper: number,
  kcHighLower: number
): SqueezeState {
  if (bbUpper < kcHighUpper && bbLower > kcHighLower) return "high";
  if (bbUpper < kcMidUpper && bbLower > kcMidLower) return "mid";
  if (bbUpper < kcLowUpper && bbLower > kcLowLower) return "low";
  if (bbUpper > kcLowUpper && bbLower < kcLowLower) return "released";
  return "none";
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
