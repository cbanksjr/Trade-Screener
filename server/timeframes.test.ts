import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/types";
import { aggregateDailyCandlesToWeeks, aggregateSequentialCandles, buildLowerTimeframeConfluence } from "./timeframes";

describe("lower-timeframe confluence", () => {
  it("uses 30-minute candles as the base selected confluence context", () => {
    const candles = intradayCandles("up", 90);
    const oneHour = aggregateSequentialCandles(candles, 2, { includeIncomplete: false });
    const fourHour = aggregateSequentialCandles(candles, 8, { includeIncomplete: false });
    const context = buildLowerTimeframeConfluence(candles);

    expect(oneHour.length).toBe(540);
    expect(fourHour.length).toBe(90);
    expect(context.thirtyMinute.bias).toBe("bullish");
    expect(context.oneHour.bias).toBe("bullish");
    expect(["none", "low", "mid", "high", "released"]).toContain(context.oneHour.squeezeState);
    expect(context.fourHour.bias).toBe("bullish");
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
    const context = buildLowerTimeframeConfluence(intradayCandles("down", 90));

    expect(context.thirtyMinute.bias).toBe("bearish");
    expect(context.oneHour.bias).toBe("bearish");
    expect(context.fourHour.bias).toBe("bearish");
  });

  it("aggregates intraday candles for chart timeframes", () => {
    const candles = intradayCandles("up", 2);

    expect(aggregateSequentialCandles(candles, 2)).toHaveLength(14);
    expect(aggregateSequentialCandles(candles, 8)).toHaveLength(4);
  });

  it("can exclude incomplete intraday bars for scanner context", () => {
    const candles = intradayCandles("up", 1).slice(0, 7);

    expect(aggregateSequentialCandles(candles, 2)).toHaveLength(4);
    expect(aggregateSequentialCandles(candles, 2, { includeIncomplete: false })).toHaveLength(3);
    expect(aggregateSequentialCandles(candles, 8, { includeIncomplete: false })).toHaveLength(0);
  });
});

function intradayCandles(direction: "up" | "down", days = 30): Candle[] {
  const candles: Candle[] = [];
  const start = Date.UTC(2026, 0, 5, 14, 30);
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < 13; slot += 1) {
      const index = day * 13 + slot;
      const close = direction === "up" ? 100 + index * 0.08 : 220 - index * 0.08;
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
