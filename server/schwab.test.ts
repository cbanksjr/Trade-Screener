import { describe, expect, it } from "vitest";
import { normalizeSchwabCallOptions, normalizeSchwabHistory, normalizeSchwabQuotes } from "./schwab";

describe("Schwab response normalizers", () => {
  it("normalizes batch quote payloads and calculates average dollar volume", () => {
    const quotes = normalizeSchwabQuotes({
      AAPL: {
        symbol: "AAPL",
        quote: { lastPrice: 210, totalVolume: 123456 },
        reference: { description: "APPLE INC", optionRoot: "AAPL" },
        fundamental: { avg10DaysVolume: 5000000 }
      }
    });

    expect(quotes).toEqual([{
      symbol: "AAPL",
      price: 210,
      companyName: "APPLE INC",
      volume: 123456,
      averageVolume: 5000000,
      rootSymbols: ["AAPL"],
      avgDollarVolume: 1050000000
    }]);
  });

  it("normalizes price history candles", () => {
    const candles = normalizeSchwabHistory({
      candles: [{ datetime: Date.UTC(2026, 4, 29), open: 10, high: 12, low: 9, close: 11, volume: 1000 }]
    });

    expect(candles).toEqual([{ date: "2026-05-29", open: 10, high: 12, low: 9, close: 11, volume: 1000 }]);
  });

  it("normalizes call option chains into liquid-call-compatible contracts", () => {
    const contracts = normalizeSchwabCallOptions({
      callExpDateMap: {
        "2026-07-17:49": {
          "200.0": [{
            symbol: "AAPL  260717C00200000",
            description: "AAPL Jul 17 2026 200 Call",
            expirationDate: "2026-07-17",
            strikePrice: 200,
            bid: 12.4,
            ask: 12.8,
            last: 12.6,
            totalVolume: 100,
            openInterest: 1000,
            delta: 0.55
          }]
        }
      }
    }, 205);

    expect(contracts[0]).toMatchObject({
      symbol: "AAPL  260717C00200000",
      expirationDate: "2026-07-17",
      optionType: "call",
      strike: 200,
      bid: 12.4,
      ask: 12.8,
      volume: 100,
      openInterest: 1000,
      delta: 0.55
    });
    expect(contracts[0].spreadPct).toBeCloseTo(3.17);
    expect(contracts[0].score).toBeGreaterThan(0);
  });
});
