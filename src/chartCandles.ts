import { isCompletedRegularSessionDate } from "../shared/marketTime";
import type { Candle } from "../shared/types";

export function normalizeChartCandles(candles: Candle[], dataAsOf = new Date()): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const candle of candles) {
    const date = candle.date.slice(0, 10);
    const normalized = { ...candle, date };
    const valid = [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
      && candle.open > 0
      && candle.high > 0
      && candle.low > 0
      && candle.close > 0
      && candle.volume >= 0
      && candle.high >= Math.max(candle.open, candle.close)
      && candle.low <= Math.min(candle.open, candle.close);
    if (valid && isCompletedRegularSessionDate(date, dataAsOf)) byDate.set(date, normalized);
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
