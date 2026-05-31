import type { Candle, LowerTimeframeConfluence, LowerTimeframeContext, TimeframeBias } from "../shared/types";
import { latestIndicators } from "./indicators";

export function buildLowerTimeframeConfluence(thirtyMinuteCandles: Candle[]): LowerTimeframeConfluence {
  const oneHourCandles = aggregateSequentialCandles(thirtyMinuteCandles, 2);
  const fourHourCandles = aggregateSequentialCandles(thirtyMinuteCandles, 8);
  return {
    oneHour: buildContext("1h", oneHourCandles),
    fourHour: buildContext("4h", fourHourCandles)
  };
}

export function aggregateSequentialCandles(candles: Candle[], candlesPerBar: number): Candle[] {
  const bySession = new Map<string, Candle[]>();
  for (const candle of candles.filter((item) => Number.isFinite(new Date(item.date).getTime())).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
    const session = new Date(candle.date).toISOString().slice(0, 10);
    bySession.set(session, [...(bySession.get(session) ?? []), candle]);
  }

  const output: Candle[] = [];
  for (const sessionCandles of bySession.values()) {
    for (let index = 0; index < sessionCandles.length; index += candlesPerBar) {
      const group = sessionCandles.slice(index, index + candlesPerBar);
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

function buildContext(timeframe: "1h" | "4h", candles: Candle[]): LowerTimeframeContext {
  if (candles.length < 50) {
    return {
      timeframe,
      bias: "unavailable",
      price: null,
      ema21: null,
      ema50: null,
      detail: timeframe + " needs at least 50 candles; only " + candles.length + " were available."
    };
  }

  const indicators = latestIndicators(candles);
  const price = candles[candles.length - 1].close;
  const bias = lowerTimeframeBias(price, indicators.ema21, indicators.ema50);
  return {
    timeframe,
    bias,
    price,
    ema21: indicators.ema21,
    ema50: indicators.ema50,
    detail: timeframe + " is " + bias + ": price $" + price.toFixed(2) + ", 21 EMA " + indicators.ema21 + ", 50 EMA " + indicators.ema50 + "."
  };
}

function lowerTimeframeBias(price: number, ema21: number, ema50: number): TimeframeBias {
  if (ema21 > ema50 && price > ema50) return "bullish";
  if (ema21 < ema50 && price < ema50) return "bearish";
  return "neutral";
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
