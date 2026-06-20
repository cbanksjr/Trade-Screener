import { describe, expect, it } from "vitest";
import { mergeFundamentalAnalysis, normalizeFundamentalAnalysis, normalizeSchwabCallOptions, normalizeSchwabHistory, normalizeSchwabPutOptions, normalizeSchwabQuotes } from "./schwab";

describe("Schwab response normalizers", () => {
  it("normalizes batch quote payloads and calculates average dollar volume", () => {
    const quotes = normalizeSchwabQuotes({
      AAPL: {
        symbol: "AAPL",
        quote: { lastPrice: 210, totalVolume: 123456 },
        reference: { description: "APPLE INC", optionRoot: "AAPL" },
        fundamental: { avg10DaysVolume: 5000000, beta: 1.12, marketCap: 3200000000000 }
      }
    });

    expect(quotes).toEqual([{
      symbol: "AAPL",
      price: 210,
      companyName: "APPLE INC",
      volume: 123456,
      averageVolume: 5000000,
      rootSymbols: ["AAPL"],
      avgDollarVolume: 1050000000,
      beta: 1.12,
      marketCap: 3200000000000,
      dividendAmount: undefined,
      dividendExDate: undefined,
      dividendFrequency: undefined,
      dividendPayAmount: undefined,
      dividendPayDate: undefined,
      dividendYield: undefined,
      eps: undefined,
      explicitZeroDividend: false,
      lastEarningsDate: undefined,
      peRatio: undefined
    }]);
  });

  it("normalizes compact fundamental analysis fields", () => {
    const [quote] = normalizeSchwabQuotes({
      MSFT: {
        symbol: "MSFT",
        quote: { lastPrice: 410, totalVolume: 20000000 },
        reference: { description: "MICROSOFT CORP" },
        fundamental: {
          avg10DaysVolume: 18000000,
          beta: 0.91,
          marketCap: 3050000000000,
          eps: 12.34,
          peRatio: 33.2,
          dividendAmount: 3.32,
          dividendYield: 0.81,
          dividendFrequency: "Quarterly",
          dividendPayDate: "2026-06-11",
          dividendExDate: "2026-05-15",
          lastEarningsDate: "2026-04-24"
        }
      }
    });

    expect(normalizeFundamentalAnalysis(quote)).toMatchObject({
      symbol: "MSFT",
      companyName: "MICROSOFT CORP",
      price: 410,
      volume: 20000000,
      averageVolume: 18000000,
      avgDollarVolume: 7380000000,
      marketCap: 3050000000000,
      beta: 0.91,
      eps: 12.34,
      peRatio: 33.2,
      dividendAmount: 3.32,
      dividendYield: 0.81,
      dividendFrequency: "Quarterly",
      dividendPayDate: "2026-06-11",
      dividendExDate: "2026-05-15",
      lastEarningsDate: "2026-04-24",
      sourceStatus: "live"
    });
    expect(normalizeFundamentalAnalysis(quote).dividendStatus).toBe("pays");
  });

  it("normalizes missing fundamental fields as unavailable values", () => {
    const analysis = normalizeFundamentalAnalysis({ symbol: "MISS", price: 25 });

    expect(analysis).toMatchObject({
      symbol: "MISS",
      price: 25,
      volume: null,
      marketCap: null,
      beta: null,
      eps: null,
      peRatio: null,
      dividendAmount: null,
      sourceStatus: "live",
      dividendStatus: "unknown",
      warnings: []
    });
  });

  it("uses Schwab fundamentals only and keeps scan context separate", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "GAP",
      schwab: { symbol: "GAP", price: 50, beta: 1.2 },
      scanResult: {
        symbol: "GAP",
        setupDirection: "long",
        dataSource: "schwab",
        price: 51,
        beta: null,
        marketCap: null,
        avgDollarVolume20d: 750000000,
        optionable: true,
        passesUniverse: true,
        grade: "A",
        score: 95,
        maxScore: 120,
        indicators: {
          ema8: 1,
          ema21: 1,
          ema34: 1,
          ema55: 1,
          ema89: 1,
          atr14: 1,
          atrContracting: true,
          bbUpper: 1,
          bbLower: 1,
          bbWidth: 1,
          bbContracting: true,
          kcLowUpper: 1,
          kcLowLower: 1,
          kcMidUpper: 1,
          kcMidLower: 1,
          kcHighUpper: 1,
          kcHighLower: 1,
          momentum: 1,
          momentumImproving: true,
          candleRangeContracting: true,
          squeezeState: "low"
        },
        longCallDecision: "Strong Long Call Candidate",
        setupQuality: "High",
        entryRecommendationType: "High Conviction Compression Entry",
        squeezeStatusByTimeframe: [],
        weeklyContextSummary: "",
        compressionQualityScore: 90,
        compressionQualityStatus: "Bullish",
        setupScore: 88,
        setupScoreStatus: "Bullish",
        institutionalFactors: [],
        multiTimeframeAlignmentSummary: "",
        relativeStrengthSummary: "",
        institutionalContextSummary: "",
        macroRegimeSummary: "",
        layerEvaluations: [],
        suggestedEntryArea: "",
        invalidationLevel: "",
        stockStopPrice: null,
        target1: null,
        target2: null,
        reasonsSupportingTrade: [],
        reasonsAgainstTrade: [],
        alertMessage: "",
        journalRecord: "",
        rules: [],
        suggestedOptions: [],
        candles: [],
        lastUpdated: "2026-05-31T00:00:00.000Z",
        warnings: []
      },
      warnings: []
    });

    expect(analysis.beta).toBe(1.2);
    expect(analysis.marketCap).toBeNull();
    expect(analysis.avgDollarVolume).toBeNull();
    expect(analysis.eps).toBeNull();
    expect(analysis.peRatio).toBeNull();
    expect(analysis.scanContext?.grade).toBe("A");
  });

  it("uses AlphaVantage fallback only for missing fundamental analysis fields", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "FILL",
      schwab: {
        symbol: "FILL",
        price: 50,
        beta: 1.2,
        marketCap: 10_000_000_000
      },
      alphaVantage: {
        symbol: "FILL",
        beta: 1.8,
        marketCap: 20_000_000_000,
        sector: "Information Technology",
        lastEarningsDate: "2026-09-01"
      },
      warnings: []
    });

    expect(analysis.beta).toBe(1.2);
    expect(analysis.marketCap).toBe(10_000_000_000);
    expect(analysis.sector).toBe("Information Technology");
    expect(analysis.lastEarningsDate).toBe("2026-09-01");
    expect(analysis.sourceStatus).toBe("mixed");
    expect(analysis.fieldSources).toMatchObject({
      beta: "schwab",
      marketCap: "schwab",
      sector: "alphavantage",
      lastEarningsDate: "alphavantage"
    });
    expect(analysis.sourceNotes).toContain("Sector from AlphaVantage fallback.");
    expect(analysis.sourceNotes).toContain("Earnings date from AlphaVantage fallback.");
  });

  it("marks explicit zero dividend values as does not pay", () => {
    const [quote] = normalizeSchwabQuotes({
      TSLA: {
        symbol: "TSLA",
        quote: { lastPrice: 250 },
        reference: { description: "TESLA INC" },
        fundamental: {
          dividendAmount: 0,
          dividendYield: 0
        }
      }
    });

    const analysis = mergeFundamentalAnalysis({
      symbol: "TSLA",
      schwab: quote,
      warnings: []
    });

    expect(analysis.dividendAmount).toBe(0);
    expect(analysis.dividendYield).toBe(0);
    expect(analysis.dividendStatus).toBe("does_not_pay");
  });

  it("marks positive dividend values as pays", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "DIV",
      schwab: {
        symbol: "DIV",
        price: 100,
        dividendAmount: 1.2,
        dividendYield: 2.4
      },
      warnings: []
    });

    expect(analysis.dividendStatus).toBe("pays");
  });

  it("marks missing dividend values as unknown", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "UNK",
      schwab: {
        symbol: "UNK",
        price: 100,
        marketCap: 10000000000
      },
      warnings: []
    });

    expect(analysis.dividendStatus).toBe("unknown");
  });

  it("normalizes price history candles", () => {
    const candles = normalizeSchwabHistory({
      candles: [{ datetime: Date.UTC(2026, 4, 29), open: 10, high: 12, low: 9, close: 11, volume: 1000 }]
    });

    expect(candles).toEqual([{ date: "2026-05-29", open: 10, high: 12, low: 9, close: 11, volume: 1000 }]);
  });

  it("preserves intraday timestamps when requested", () => {
    const candles = normalizeSchwabHistory({
      candles: [{ datetime: Date.UTC(2026, 4, 29, 14, 30), open: 10, high: 12, low: 9, close: 11, volume: 1000 }]
    }, { includeTime: true });

    expect(candles[0].date).toBe("2026-05-29T14:30:00.000Z");
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

  it("normalizes put option chains into liquid-put-compatible contracts", () => {
    const contracts = normalizeSchwabPutOptions({
      putExpDateMap: {
        "2026-07-17:49": {
          "200.0": [{
            symbol: "AAPL  260717P00200000",
            description: "AAPL Jul 17 2026 200 Put",
            expirationDate: "2026-07-17",
            strikePrice: 200,
            bid: 10.1,
            ask: 10.5,
            last: 10.3,
            totalVolume: 85,
            openInterest: 900,
            delta: -0.48
          }]
        }
      }
    }, 205);

    expect(contracts[0]).toMatchObject({
      symbol: "AAPL  260717P00200000",
      expirationDate: "2026-07-17",
      optionType: "put",
      strike: 200,
      bid: 10.1,
      ask: 10.5,
      volume: 85,
      openInterest: 900,
      delta: -0.48
    });
    expect(contracts[0].score).toBeGreaterThan(0);
  });

});
