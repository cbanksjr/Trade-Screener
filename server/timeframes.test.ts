import { describe, expect, it } from "vitest";
import type { Candle } from "../shared/types";
import { aggregateDailyCandlesToWeeks } from "./timeframes";

describe("timeframe aggregation", () => {
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
});
