import { describe, expect, it } from "vitest";
import { normalizeChartCandles } from "./chartCandles";

describe("candlestick chart data", () => {
  it("keeps unique, valid candles in chronological order", () => {
    const candles = normalizeChartCandles([
      { date: "2026-07-14", open: 20, high: 22, low: 19, close: 21, volume: 100 },
      { date: "2026-07-13T20:00:00.000Z", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: "2026-07-13", open: 11, high: 13, low: 10, close: 12, volume: 200 },
      { date: "2026-07-12", open: 10, high: 9, low: 8, close: 11, volume: 100 }
    ], new Date("2026-07-14T20:00:00.000Z"));

    expect(candles).toEqual([
      { date: "2026-07-13", open: 11, high: 13, low: 10, close: 12, volume: 200 },
      { date: "2026-07-14", open: 20, high: 22, low: 19, close: 21, volume: 100 }
    ]);
  });
});
