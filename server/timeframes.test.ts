import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/types";
import { aggregateDailyCandlesToWeeks, aggregateSequentialCandles, buildLowerTimeframeConfluence } from "./timeframes";

describe("lower-timeframe confluence", () => {
  it("aggregates 30-minute candles into 1h and 4h confluence contexts", () => {
    const candles = intradayCandles("up");
    const oneHour = aggregateSequentialCandles(candles, 2);
    const fourHour = aggregateSequentialCandles(candles, 8);
    const context = buildLowerTimeframeConfluence(candles);

    expect(oneHour.length).toBe(120);
    expect(fourHour.length).toBe(30);
    expect(context.oneHour.bias).toBe("bullish");
    expect(["none", "low", "mid", "high", "released"]).toContain(context.oneHour.squeezeState);
    expect(context.fourHour.bias).toBe("unavailable");
    expect(context.fourHour.squeezeState).toBe("none");
  });

  it("aggregates daily candles into weekly candles", () => {
    const candles: Candle[] = [
      { date: "2026-01-05", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: "2026-01-06", open: 11, high: 14, low: 10, close: 13, volume: 200 },
      { date: "2026-01-12", open: 13, high: 15, low: 12, close: 14, volume: 300 }
    ];

    expect(aggregateDailyCandlesToWeeks(candles)).toEqual([
      { date: "2026-01-05", open: 10, high: 14, low: 9, close: 13, volume: 300 },
      { date: "2026-01-12", open: 13, high: 15, low: 12, close: 14, volume: 300 }
    ]);
  });

  it("detects bearish 1h and 4h confluence when enough intraday history is available", () => {
    const context = buildLowerTimeframeConfluence(intradayCandles("down", 60));

    expect(context.oneHour.bias).toBe("bearish");
    expect(context.fourHour.bias).toBe("bearish");
  });

  it("aggregates intraday candles for chart timeframes", () => {
    const candles = intradayCandles("up", 2);

    expect(aggregateSequentialCandles(candles, 2)).toHaveLength(8);
    expect(aggregateSequentialCandles(candles, 8)).toHaveLength(2);
  });
});

function intradayCandles(direction: "up" | "down", days = 30): Candle[] {
  const candles: Candle[] = [];
  const start = Date.UTC(2026, 0, 5, 14, 30);
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < 8; slot += 1) {
      const index = day * 8 + slot;
      const close = direction === "up" ? 100 + index * 0.35 : 220 - index * 0.35;
      candles.push({
        date: new Date(start + day * 24 * 60 * 60 * 1000 + slot * 30 * 60 * 1000).toISOString(),
        open: close - 0.15,
        high: close + 0.8,
        low: close - 0.8,
        close,
        volume: 1_000_000
      });
    }
  }
  return candles;
}
