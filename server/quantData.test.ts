import { describe, expect, it } from "vitest";
import type { InstitutionalPositioningSummary, ScanResult } from "../shared/types";
import { applyInstitutionalPositioning } from "./scoring";
import {
  createQuantDataPositioningProvider,
  normalizeDarkPool,
  normalizeOptionsExposure,
  normalizeOptionsFlow,
  previousTradingSessionDate,
  type QuantDataCache
} from "./quantData";

describe("QuantData Institutional Positioning", () => {
  it("normalizes bullish options flow from net drift and ask-side call activity", () => {
    const flow = normalizeOptionsFlow({
      data: {
        "1778679000000": { netCallPremium: 180_000, netPutPremium: 40_000, netCallVolume: 6_200 },
        "1778679300000": { netCallPremium: 90_000, netPutPremium: 25_000, netCallVolume: 1_100 }
      }
    }, {
      data: [
        { contractType: "CALL", sentiment: "ASK", premium: 80_000, isSweep: true, openClose: "OPEN" },
        { contractType: "CALL", sentiment: "ASK", premium: 75_000, isSweep: true, openClose: "OPEN" }
      ]
    });

    expect(flow.signal).toBe("bullish");
    expect(flow.flags).toContain("Bullish Flow Confirmation");
    expect(flow.flags).toContain("Ask-Side Call Buying");
    expect(flow.flags).toContain("Unusual Call Volume");
  });

  it("does not let ask-side call premium inflate the call/put premium total", () => {
    const flow = normalizeOptionsFlow({
      data: {
        "1778679000000": { netCallPremium: 30_000, netPutPremium: 20_000 }
      }
    }, {
      data: [
        { contractType: "CALL", sentiment: "ASK", premium: 500_000, isSweep: true, openClose: "OPEN" }
      ]
    });

    expect(flow.flags).toContain("Ask-Side Call Buying");
    expect(flow.signal).not.toBe("bullish");
    expect(flow.detail).toContain("Call premium $30K");
  });

  it("detects bearish put-heavy flow as a veto-grade signal", () => {
    const flow = normalizeOptionsFlow({
      data: {
        "1778679000000": { netCallPremium: 40_000, netPutPremium: 350_000, netCallVolume: 400, netPutVolume: 7_000 }
      }
    });

    expect(flow.signal).toBe("bearish");
    expect(flow.stronglyBearish).toBe(true);
    expect(flow.flags).toContain("Bearish Flow Veto");
  });

  it("classifies supportive and hostile exposure structures", () => {
    const supportive = normalizeOptionsExposure({
      data: {
        AAPL: {
          stockPrice: 100,
          exposureMap: {
            "2026-07-17": {
              "97.5": { putExposure: -180_000 },
              "105.0": { callExposure: 60_000 }
            }
          }
        }
      }
    }, 100);
    const hostile = normalizeOptionsExposure({
      data: {
        AAPL: {
          stockPrice: 100,
          exposureMap: {
            "2026-07-17": {
              "101.0": { callExposure: 250_000 },
              "97.5": { putExposure: -40_000 }
            }
          }
        }
      }
    }, 100);

    expect(supportive.signal).toBe("squeeze_prone");
    expect(supportive.flags).toContain("Put Support Below Price");
    expect(supportive.flags).toContain("Squeeze-Prone Exposure");
    expect(hostile.signal).toBe("hostile");
    expect(hostile.flags).toContain("Good Chart, Options Resistance");
  });

  it("reads dark-pool levels as accumulation near held support", () => {
    const darkPool = normalizeDarkPool({
      latestStockPrice: 101,
      data: {
        "99.50": { notionalValue: 12_000_000, size: 120_000, tradeCount: 80 },
        "106.00": { notionalValue: 2_000_000, size: 20_000, tradeCount: 10 }
      }
    }, 101);

    expect(darkPool.signal).toBe("accumulation");
    expect(darkPool.flags).toContain("Dark-Pool Accumulation");
  });

  it("keeps setup grade and marks Avoid when positioning is bearish", () => {
    const capped = applyInstitutionalPositioning(baseResult(95, "A"), positioning("capped"));
    const vetoed = applyInstitutionalPositioning(baseResult(95, "A"), positioning("vetoed", ["Bearish Flow Veto"]));

    expect(capped.grade).toBe("A");
    expect(capped.tradeMark).toBe("Avoid");
    expect(capped.longCallDecision).toBe("Avoid");
    expect(capped.strongLongCallCandidate).toBe(false);
    expect(vetoed.longCallDecision).toBe("Avoid");
    expect(vetoed.strongLongCallCandidate).toBe(false);
  });

  it("can confirm a clean high-B setup without changing setup grade", () => {
    const result = applyInstitutionalPositioning(baseResult(88, "B"), positioning("confirmed", ["Bullish Flow Confirmation"]));

    expect(result.grade).toBe("B");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.strongLongCallCandidate).toBe(false);
  });

  it("uses QuantData POST endpoints with bearer auth and reuses fresh cache", async () => {
    const requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const cache: QuantDataCache = { responses: {} };
    const provider = createQuantDataPositioningProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
      maxCalls: 4,
      cache,
      now: () => new Date("2026-06-30T15:00:00.000Z"),
      fetchImpl: async (input, init) => {
        requests.push({
          url: input.toString(),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
        });
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
    });

    await provider.enrich("AAPL", 100);
    await provider.enrich("AAPL", 100);

    expect(requests).toHaveLength(4);
    expect(requests[0].url).toContain("/v1/options/tool/net-drift");
    expect(requests[0].body.sessionDateRange).toEqual({ startDate: "2026-06-29", endDate: "2026-06-29" });
    expect(requests[1].body.sessionDateRange).toEqual({ startDate: "2026-06-29", endDate: "2026-06-29" });
    expect(requests[2].body.sessionDateRange).toBeUndefined();
    expect(requests.every((request) => request.auth === "Bearer test-key")).toBe(true);
    expect(provider.remainingCalls()).toBe(0);
  });

  it("resolves the previous completed U.S. trading session for options flow", () => {
    expect(previousTradingSessionDate(new Date("2026-06-30T15:00:00.000Z"))).toBe("2026-06-29");
    expect(previousTradingSessionDate(new Date("2026-06-29T15:00:00.000Z"))).toBe("2026-06-26");
    expect(previousTradingSessionDate(new Date("2026-07-06T15:00:00.000Z"))).toBe("2026-07-02");
    expect(previousTradingSessionDate(new Date("2022-01-03T15:00:00.000Z"))).toBe("2021-12-30");
  });
});

function positioning(status: InstitutionalPositioningSummary["status"], flags: string[] = []): InstitutionalPositioningSummary {
  return {
    score: status === "confirmed" ? 92 : status === "neutral" ? 50 : 20,
    optionsFlowSignal: status === "confirmed" ? "bullish" : status === "vetoed" ? "bearish" : "mixed",
    optionsExposureSignal: status === "confirmed" ? "supportive" : status === "capped" ? "hostile" : "neutral",
    darkPoolSignal: status === "confirmed" ? "accumulation" : "neutral",
    status,
    reason: "QuantData test positioning.",
    flags,
    warnings: []
  };
}

function baseResult(setupScore: number, grade: ScanResult["grade"]): ScanResult {
  return {
    symbol: "TEST",
    assetType: "stock",
    setupDirection: "long",
    dataSource: "schwab",
    price: 100,
    beta: 1,
    marketCap: 10_000_000_000,
    avgDollarVolume20d: 500_000_000,
    optionable: true,
    passesUniverse: true,
    grade,
    longCallDecision: grade === "A" ? "Strong Long Call Candidate" : "Moderate Long Call Candidate",
    setupQuality: grade === "A" ? "High" : "Moderate",
    entryRecommendationType: grade === "A" ? "High Conviction Compression Entry" : "Early Compression Entry",
    score: 5,
    maxScore: 5,
    indicators: {
      ema8: 102,
      ema21: 100,
      ema34: 98,
      ema50: 97,
      ema55: 96,
      ema89: 95,
      ema100: 94,
      atr14: 2,
      atrContracting: true,
      bbUpper: 103,
      bbLower: 97,
      bbWidth: 6,
      bbContracting: true,
      kcLowUpper: 104,
      kcLowLower: 96,
      kcMidUpper: 105,
      kcMidLower: 95,
      kcHighUpper: 106,
      kcHighLower: 94,
      momentum: 1,
      momentumImproving: true,
      candleRangeContracting: true,
      squeezeState: "low"
    },
    squeezeStatusByTimeframe: [
      {
        timeframe: "daily",
        squeezeState: "low",
        bias: "bullish",
        priceAboveEmaStack: true,
        positiveEmaStack: true,
        withinOneAtrOfEma21: true,
        withinEmaPocket: true,
        compressionStatus: "Bullish",
        detail: "Daily bullish."
      },
      {
        timeframe: "weekly",
        squeezeState: "low",
        bias: "bullish",
        priceAboveEmaStack: true,
        positiveEmaStack: true,
        withinOneAtrOfEma21: true,
        withinEmaPocket: true,
        compressionStatus: "Bullish",
        detail: "Weekly bullish."
      }
    ],
    dailyEntryQualificationMode: "strict",
    weeklyQualificationMode: "full-stack",
    squeezeMaturityMode: "mature",
    weeklyContextSummary: "Weekly bullish.",
    compressionQualityScore: 5,
    compressionQualityStatus: "Bullish",
    setupScore,
    setupScoreStatus: setupScore >= 90 ? "Bullish" : "Neutral",
    institutionalFactors: [],
    gradeCapReasons: setupScore < 90 ? ["Setup score below 90."] : [],
    multiTimeframeAlignmentSummary: "Aligned.",
    relativeStrengthSummary: "Strong.",
    institutionalContextSummary: "Pass.",
    macroRegimeSummary: "Pass.",
    layerEvaluations: [],
    suggestedEntryArea: "$100",
    invalidationLevel: "$95",
    stockStopPrice: 95,
    target1: 105,
    target2: 110,
    reasonsSupportingTrade: [],
    reasonsAgainstTrade: [],
    alertMessage: "TEST",
    journalRecord: "TEST",
    rules: [],
    suggestedOptions: [],
    candles: [],
    lastUpdated: "2026-06-29T15:00:00.000Z",
    warnings: []
  };
}
