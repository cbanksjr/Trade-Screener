import { describe, expect, it } from "vitest";
import type { InstitutionalEdgeSummary, ScanResult } from "../shared/types";
import {
  createFmpInstitutionalEdgeProvider,
  normalizeAnalystConviction,
  normalizeEtfInfo,
  normalizeEtfSectorWeightings,
  normalizeFinancialScores,
  normalizeInsiderStatistics,
  normalizeInstitutionalOwnership,
  type FmpInstitutionalEdgeCache
} from "./fmpInstitutionalEdge";
import { applyInstitutionalEdge } from "./scoring";

describe("FMP Institutional Edge", () => {
  it("normalizes financial scores into bullish and bearish edge factors", () => {
    expect(normalizeFinancialScores([{ piotroskiScore: 7, altmanZScore: 4 }])).toMatchObject({
      name: "Financial Quality",
      status: "Bullish",
      adjustment: 2
    });
    expect(normalizeFinancialScores([{ piotroskiScore: 2, altmanZScore: 1.2 }])).toMatchObject({
      name: "Financial Quality",
      status: "Bearish",
      adjustment: -5
    });
  });

  it("combines analyst grades and price target upside", () => {
    expect(normalizeAnalystConviction([{
      strongBuy: 4,
      buy: 5,
      hold: 1,
      sell: 0,
      strongSell: 0
    }], [{ priceTargetAverage: 120 }], 100)).toMatchObject({
      name: "Analyst Conviction",
      status: "Bullish"
    });

    expect(normalizeAnalystConviction([{
      strongBuy: 0,
      buy: 1,
      hold: 3,
      sell: 2,
      strongSell: 1
    }], [{ priceTargetAverage: 90 }], 100)).toMatchObject({
      name: "Analyst Conviction",
      status: "Bearish"
    });
  });

  it("normalizes ownership, insider, and ETF fields when available", () => {
    expect(normalizeInstitutionalOwnership([{ changeInSharesNumberPercentage: 8, changeInInvestorsHolding: 3 }])).toMatchObject({
      name: "Institutional Positioning",
      status: "Bullish"
    });
    expect(normalizeInsiderStatistics([{ totalPurchases: 1, totalSales: 4 }])).toMatchObject({
      name: "Insider Safety",
      status: "Bearish"
    });
    expect(normalizeEtfInfo([{ assetsUnderManagement: 12_000_000_000, expenseRatio: 0.0009 }])).toMatchObject({
      name: "ETF Quality",
      status: "Bullish"
    });
    expect(normalizeEtfSectorWeightings([{ sector: "Technology", weightPercentage: 32 }])).toMatchObject({
      name: "ETF Exposure",
      status: "Neutral"
    });
  });

  it("marks plan-restricted endpoints unavailable and avoids repeated probes during the TTL", async () => {
    let calls = 0;
    const cache: FmpInstitutionalEdgeCache = { availability: {}, responses: {} };
    const provider = createFmpInstitutionalEdgeProvider({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 10,
      cache,
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "Please upgrade your plan." }), { status: 403 });
      }
    });

    const first = await provider.enrich("AAPL", "stock", 100);
    const second = await provider.enrich("MSFT", "stock", 100);

    expect(first.edge.factors).toEqual([]);
    expect(first.edge.status).toBe("Neutral");
    expect(second.edge.status).toBe("Neutral");
    expect(calls).toBe(5);
    expect(provider.cache().availability["financial-scores"]?.available).toBe(false);
    expect(provider.remainingCalls()).toBe(5);
  });

  it("reuses fresh cached endpoint payloads without live FMP calls", async () => {
    let calls = 0;
    const cache: FmpInstitutionalEdgeCache = {
      availability: {},
      responses: {
        AAPL: {
          "financial-scores": {
            updatedAt: "2026-06-23T11:00:00.000Z",
            data: [{ piotroskiScore: 8, altmanZScore: 4.2 }]
          }
        }
      }
    };
    const provider = createFmpInstitutionalEdgeProvider({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 0,
      cache,
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return new Response("[]");
      }
    });

    const result = await provider.enrich("AAPL", "stock", 100);

    expect(result.edge.factors).toEqual([
      expect.objectContaining({ name: "Financial Quality", status: "Bullish" })
    ]);
    expect(calls).toBe(0);
  });

  it("respects the Institutional Edge call budget", async () => {
    const requests: string[] = [];
    const provider = createFmpInstitutionalEdgeProvider({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      now: () => new Date("2026-06-23T12:00:00.000Z"),
      fetchImpl: async (input) => {
        requests.push(new URL(input.toString()).pathname);
        return new Response(JSON.stringify([{ piotroskiScore: 8, altmanZScore: 4 }]));
      }
    });

    const result = await provider.enrich("AAPL", "stock", 100);

    expect(requests).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("call budget exhausted");
    expect(provider.remainingCalls()).toBe(0);
  });

  it("adjusts qualified setup scores but caps A when edge is bearish", () => {
    expect(applyInstitutionalEdge(baseResult(88, "B"), edge("Bullish", 5)).grade).toBe("A");

    const capped = applyInstitutionalEdge(baseResult(95, "A"), edge("Bearish", -5));

    expect(capped.setupScore).toBe(90);
    expect(capped.grade).toBe("B");
    expect(capped.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(capped.gradeCapReasons).toContain("Institutional Edge is bearish.");
  });

  it("does not promote an ATR-only weekly setup above B", () => {
    const result = applyInstitutionalEdge({
      ...baseResult(88, "B"),
      weeklyQualificationMode: "ema21-atr"
    }, edge("Bullish", 5));

    expect(result.setupScore).toBe(93);
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Weekly chart qualifies by 21 EMA proximity but does not have the full bullish EMA stack.");
  });

  it("does not promote a broad daily entry above B", () => {
    const result = applyInstitutionalEdge({
      ...baseResult(88, "B"),
      dailyEntryQualificationMode: "broad"
    }, edge("Bullish", 5));

    expect(result.setupScore).toBe(93);
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Daily price is between the 21 EMA and 8 EMA but outside the stricter buffered A-entry pocket.");
  });

  it("does not promote a developing squeeze above B", () => {
    const result = applyInstitutionalEdge({
      ...baseResult(88, "B"),
      squeezeMaturityMode: "developing"
    }, edge("Bullish", 5));

    expect(result.setupScore).toBe(93);
    expect(result.grade).toBe("B");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.gradeCapReasons).toContain("Daily squeeze has 3-4 active dots; developing compression is capped at B.");
  });
});

function edge(status: InstitutionalEdgeSummary["status"], adjustment: number): InstitutionalEdgeSummary {
  return {
    status,
    score: adjustment,
    adjustment,
    factors: [],
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
    weeklyContextSummary: "Weekly bullish.",
    compressionQualityScore: 5,
    compressionQualityStatus: "Bullish",
    setupScore,
    setupScoreStatus: setupScore >= 90 ? "Bullish" : "Neutral",
    institutionalFactors: [],
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
    lastUpdated: "2026-06-23T12:00:00.000Z",
    warnings: []
  };
}
