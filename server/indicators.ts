import type { Candle, IndicatorSnapshot, SqueezeMomentumColor, SqueezeState } from "../shared/types";

export const MIN_CANDLES_REQUIRED = 90;

export function ema(values: number[], period: number): number[] {
  const multiplier = 2 / (period + 1);
  const output: number[] = [];
  const seedLength = Math.min(period, values.length);
  let seedSum = 0;
  values.forEach((value, index) => {
    if (index < seedLength - 1) {
      seedSum += value;
      output.push(NaN);
      return;
    }
    if (index === seedLength - 1) {
      seedSum += value;
      output.push(seedSum / seedLength);
      return;
    }
    output.push(value * multiplier + output[index - 1] * (1 - multiplier));
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
  if (candles.length < MIN_CANDLES_REQUIRED) {
    throw new Error("At least " + MIN_CANDLES_REQUIRED + " candles are required to calculate the compression setup.");
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
  const momentumSeries = squeezeMomentumSeries(candles, squeezePeriod);
  const momentum = momentumSeries.at(-1) ?? 0;
  const previousMomentum = momentumSeries.at(-2) ?? momentum;
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
    momentumImproving: momentum > previousMomentum,
    momentumColor: squeezeMomentumColor(momentum, previousMomentum),
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

export function squeezeStateSeries(candles: Candle[]): SqueezeState[] {
  const squeezePeriod = 20;
  const closes = candles.map((candle) => candle.close);
  const basisSeries = sma(closes, squeezePeriod);
  const deviationSeries = rollingStandardDeviation(closes, squeezePeriod);
  const kcRangeSeries = sma(trueRanges(candles), squeezePeriod);

  return candles.map((_candle, index) => {
    const basis = basisSeries[index];
    const deviation = deviationSeries[index];
    const kcRange = kcRangeSeries[index];
    const bbUpper = basis + deviation * 2;
    const bbLower = basis - deviation * 2;
    return squeezeState(
      bbUpper,
      bbLower,
      basis + kcRange * 2,
      basis - kcRange * 2,
      basis + kcRange * 1.5,
      basis - kcRange * 1.5,
      basis + kcRange,
      basis - kcRange
    );
  });
}

function rollingStandardDeviation(values: number[], period: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    return standardDeviation(values.slice(start, index + 1));
  });
}

export function activeSqueezeDotCount(candles: Candle[]): number {
  if (candles.length < MIN_CANDLES_REQUIRED) return 0;
  const states = squeezeStateSeries(candles);
  let count = 0;
  for (let index = candles.length - 1; index >= MIN_CANDLES_REQUIRED - 1; index -= 1) {
    if (!isActiveSqueeze(states[index])) break;
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

export function squeezeMomentumSeries(candles: Candle[], period = 20): number[] {
  const rawMomentum = candles.map((candle, index) => {
    const start = Math.max(0, index - period + 1);
    const window = candles.slice(start, index + 1);
    const highestHigh = Math.max(...window.map((item) => item.high));
    const lowestLow = Math.min(...window.map((item) => item.low));
    const averageClose = average(window.map((item) => item.close));
    const midpointBaseline = ((highestHigh + lowestLow) / 2 + averageClose) / 2;
    return candle.close - midpointBaseline;
  });

  return rawMomentum.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    return linearRegressionLast(rawMomentum.slice(start, index + 1));
  });
}

export function linearRegressionLast(values: number[]): number {
  if (values.length <= 1) return values[0] ?? 0;
  const count = values.length;
  const sumX = (count * (count - 1)) / 2;
  const sumY = values.reduce((sum, value) => sum + value, 0);
  const sumXX = values.reduce((sum, _value, index) => sum + index * index, 0);
  const sumXY = values.reduce((sum, value, index) => sum + index * value, 0);
  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) return values[count - 1];
  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;
  return slope * (count - 1) + intercept;
}

export function squeezeMomentumColor(momentum: number, previousMomentum: number): SqueezeMomentumColor {
  if (momentum >= 0) return momentum > previousMomentum ? "cyan" : "blue";
  return momentum < previousMomentum ? "red" : "yellow";
}

export function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}
