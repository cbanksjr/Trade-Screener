import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "./config";
import { __resetSchwabTokenCacheForTest, fetchCallOptions, fetchOptionsForPositioning, fetchQuote, mergeFundamentalAnalysis, normalizeFundamentalAnalysis, normalizeSchwabCallOptions, normalizeSchwabHistory, normalizeSchwabPutOptions, normalizeSchwabQuotes, selectCallOptionsForScan } from "./schwab";
import { getSetting, resetMemoryStoreForTests, setSetting } from "./memoryStore";

describe("Schwab response normalizers", () => {
  it("normalizes batch quote payloads and calculates average dollar volume", () => {
    const quotes = normalizeSchwabQuotes({
      AAPL: {
        symbol: "AAPL",
        quote: { lastPrice: 210, totalVolume: 123456 },
        reference: { description: "APPLE INC", optionRoot: "AAPL" },
        fundamental: { avg10DaysVolume: 5000000, beta: 1.12, marketCap: 3200000000000 }
      }
    }, new Date("2026-07-14T14:30:00.000Z"));

    expect(quotes).toEqual([{
      symbol: "AAPL",
      price: 210,
      priceAsOf: "2026-07-14T14:30:00.000Z",
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

  it("preserves negative and zero EPS, beta, and P/E instead of treating them as unavailable", () => {
    const [quote] = normalizeSchwabQuotes({
      LOSSCO: {
        symbol: "LOSSCO",
        quote: { lastPrice: 15, totalVolume: 500000 },
        reference: { description: "LOSS MAKING CO" },
        fundamental: {
          avg10DaysVolume: 1000000,
          beta: -0.4,
          marketCap: 5000000000,
          eps: -2.15,
          peRatio: -6.98
        }
      }
    });

    expect(quote.beta).toBe(-0.4);
    expect(quote.eps).toBe(-2.15);
    expect(quote.peRatio).toBe(-6.98);
  });

  it("still treats zero or negative market cap and average volume as unavailable", () => {
    const [quote] = normalizeSchwabQuotes({
      ZEROVOL: {
        symbol: "ZEROVOL",
        quote: { lastPrice: 15, totalVolume: 500000 },
        reference: { description: "ZERO VOLUME CO" },
        fundamental: {
          avg10DaysVolume: 0,
          marketCap: -1
        }
      }
    });

    expect(quote.averageVolume).toBeUndefined();
    expect(quote.marketCap).toBeUndefined();
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
        assetType: "stock",
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
          ema50: 1,
          ema55: 1,
          ema89: 1,
          ema100: 1,
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

  it("uses FMP fallback only for missing fundamental analysis fields", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "FILL",
      schwab: {
        symbol: "FILL",
        price: 50,
        beta: 1.2,
        marketCap: 10_000_000_000
      },
      fmp: {
        symbol: "FILL",
        beta: 1.8,
        marketCap: 20_000_000_000,
        sector: "Information Technology",
        nextEarningsDate: "2026-09-01"
      },
      warnings: []
    });

    expect(analysis.beta).toBe(1.2);
    expect(analysis.marketCap).toBe(10_000_000_000);
    expect(analysis.sector).toBe("Information Technology");
    expect(analysis.nextEarningsDate).toBe("2026-09-01");
    expect(analysis.sourceStatus).toBe("mixed");
    expect(analysis.fieldSources).toMatchObject({
      beta: "schwab",
      marketCap: "schwab",
      sector: "fmp",
      nextEarningsDate: "fmp"
    });
    expect(analysis.sourceNotes).toContain("Sector from FMP fallback.");
    expect(analysis.sourceNotes).toContain("Next earnings date from FMP fallback.");
  });

  it("keeps Schwab last earnings separate from FMP next earnings", () => {
    const analysis = mergeFundamentalAnalysis({
      symbol: "EARN",
      schwab: {
        symbol: "EARN",
        price: 50,
        lastEarningsDate: "2026-08-01"
      },
      fmp: {
        symbol: "EARN",
        nextEarningsDate: "2026-09-01"
      },
      warnings: []
    });

    expect(analysis.lastEarningsDate).toBe("2026-08-01");
    expect(analysis.nextEarningsDate).toBe("2026-09-01");
    expect(analysis.fieldSources).toMatchObject({
      lastEarningsDate: "schwab",
      nextEarningsDate: "fmp"
    });
    expect(analysis.sourceNotes).toContain("Next earnings date from FMP fallback.");
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

  it("sorts, deduplicates, validates, and excludes an unfinished daily candle", () => {
    const payload = {
      candles: [
        { datetime: Date.UTC(2026, 6, 14), open: 20, high: 22, low: 19, close: 21, volume: 100 },
        { datetime: Date.UTC(2026, 6, 13), open: 10, high: 12, low: 9, close: 11, volume: 100 },
        { datetime: Date.UTC(2026, 6, 13, 1), open: 11, high: 13, low: 10, close: 12, volume: 200 },
        { datetime: Date.UTC(2026, 6, 12), open: 10, high: 9, low: 8, close: 11, volume: 100 }
      ]
    };

    const beforeClose = normalizeSchwabHistory(payload, {
      completedOnly: true,
      now: new Date("2026-07-14T19:59:00.000Z")
    });
    const afterClose = normalizeSchwabHistory(payload, {
      completedOnly: true,
      now: new Date("2026-07-14T20:00:00.000Z")
    });

    expect(beforeClose).toEqual([{ date: "2026-07-13", open: 11, high: 13, low: 10, close: 12, volume: 200 }]);
    expect(afterClose.map((candle) => candle.date)).toEqual(["2026-07-13", "2026-07-14"]);
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

  it("computes days-to-expiration against the correct UTC market-close offset across DST", () => {
    const optionAt = (expirationDate: string) => normalizeSchwabCallOptions({
      callExpDateMap: {
        [expirationDate + ":1"]: {
          "200.0": [{
            symbol: "TEST",
            expirationDate,
            strikePrice: 200,
            bid: 1,
            ask: 1.1
          }]
        }
      }
    }, 200)[0];

    try {
      // EDT (summer): market close is 20:00 UTC (4pm ET).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
      expect(optionAt("2026-07-17").dte).toBe(17);

      // EST (winter): market close is 21:00 UTC (4pm ET).
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      expect(optionAt("2026-01-16").dte).toBe(16);
    } finally {
      vi.useRealTimers();
    }
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

  it("selects the grading calls from an already-loaded call/put chain", () => {
    const calls = normalizeSchwabCallOptions({
      callExpDateMap: {
        "2026-08-21:37": {
          "105.0": [{ symbol: "TEST-C105", expirationDate: "2026-08-21", strikePrice: 105, bid: 1.9, ask: 2.1, totalVolume: 500, openInterest: 2_000 }],
          "130.0": [{ symbol: "TEST-C130", expirationDate: "2026-08-21", strikePrice: 130, bid: 0.9, ask: 1.1, totalVolume: 500, openInterest: 2_000 }]
        }
      }
    }, 100);
    const puts = normalizeSchwabPutOptions({
      putExpDateMap: {
        "2026-08-21:37": {
          "95.0": [{ symbol: "TEST-P95", expirationDate: "2026-08-21", strikePrice: 95, bid: 0.9, ask: 1.1, totalVolume: 500, openInterest: 2_000 }]
        }
      }
    }, 100);

    expect(selectCallOptionsForScan([...calls, ...puts], 100).map((contract) => contract.symbol)).toEqual(["TEST-C105"]);
  });

});

describe("Schwab request resilience", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    __resetSchwabTokenCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSchwabTokenCacheForTest();
  });

  it("bounds option-chain responses with the configured strike count", async () => {
    await setSetting("schwabTokens", {
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ callExpDateMap: {} }), { status: 200 });
    }));

    await fetchCallOptions("AAPL", 200);

    expect(new URL(requestedUrl).searchParams.get("strikeCount")).toBe(String(config.schwabOptionStrikeCount));
  });

  it("requests a bounded ALL chain and preserves puts and gamma for positioning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T15:00:00.000Z"));
    try {
      await setSetting("schwabTokens", {
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      });
      let requestedUrl = "";
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          callExpDateMap: {
            "2026-08-21:37": {
              "100.0": [{
                symbol: "TEST  260821C00100000",
                expirationDate: "2026-08-21",
                strikePrice: 100,
                bid: 1.9,
                ask: 2.1,
                totalVolume: 500,
                openInterest: 2_000,
                gamma: 0.02
              }]
            }
          },
          putExpDateMap: {
            "2026-08-21:37": {
              "95.0": [{
                symbol: "TEST  260821P00095000",
                expirationDate: "2026-08-21",
                strikePrice: 95,
                bid: 0.9,
                ask: 1.1,
                totalVolume: 200,
                openInterest: 3_000,
                gamma: 0.04
              }]
            }
          }
        }), { status: 200 });
      }));

      const contracts = await fetchOptionsForPositioning("TEST", 100);
      const url = new URL(requestedUrl);

      expect(url.searchParams.get("contractType")).toBe("ALL");
      expect(url.searchParams.get("strikeCount")).toBe(String(config.schwabOptionStrikeCount));
      expect(contracts.map((contract) => contract.optionType)).toEqual(["put", "call"]);
      expect(contracts.find((contract) => contract.optionType === "put")?.gamma).toBe(0.04);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent token refreshes so only one refresh request is sent", async () => {
    await setSetting("schwabTokens", {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${config.schwabAuthBaseUrl}/token`)) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ access_token: "fresh-token", refresh_token: "refresh-token", expires_in: 1800 }), { status: 200 });
      }
      if (url.startsWith(`${config.schwabMarketDataBaseUrl}/quotes`)) {
        const symbol = new URL(url).searchParams.get("symbols") ?? "UNKNOWN";
        return new Response(JSON.stringify({
          [symbol]: { symbol, quote: { lastPrice: 100 }, reference: {}, fundamental: {} }
        }), { status: 200 });
      }
      throw new Error("Unexpected fetch to " + url);
    });
    vi.stubGlobal("fetch", fetchImpl);

    await Promise.all(["AAPL", "MSFT", "GOOGL", "TSLA"].map((symbol) => fetchQuote(symbol)));

    expect(refreshCalls).toBe(1);
  });

  it("retries a transient 429 before succeeding on a quote request", async () => {
    await setSetting("schwabTokens", {
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });

    let quoteAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${config.schwabAuthBaseUrl}/token`)) {
        return new Response(JSON.stringify({ access_token: "valid-token", refresh_token: "refresh-token", expires_in: 1800 }), { status: 200 });
      }
      if (url.startsWith(`${config.schwabMarketDataBaseUrl}/quotes`)) {
        quoteAttempts += 1;
        if (quoteAttempts < 2) return new Response("rate limited", { status: 429 });
        const symbol = new URL(url).searchParams.get("symbols") ?? "UNKNOWN";
        return new Response(JSON.stringify({
          [symbol]: { symbol, quote: { lastPrice: 210 }, reference: {}, fundamental: {} }
        }), { status: 200 });
      }
      throw new Error("Unexpected fetch to " + url);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const quote = await fetchQuote("RETRY");

    expect(quote?.price).toBe(210);
    expect(quoteAttempts).toBe(2);
  });

  it("clears stored tokens when Schwab rejects a refresh token", async () => {
    await setSetting("schwabTokens", {
      accessToken: "expired-token",
      refreshToken: "expired-refresh-token",
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${config.schwabAuthBaseUrl}/token`)) {
        return new Response("<HTML><TITLE>Access Denied</TITLE></HTML>", { status: 403, statusText: "Forbidden" });
      }
      throw new Error("Unexpected fetch to " + url);
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(fetchQuote("AAPL")).rejects.toThrow("Use Connect Schwab to reconnect");
    await expect(getSetting("schwabTokens", undefined)).resolves.toBeUndefined();
  });
});
