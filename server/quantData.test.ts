import { describe, expect, it } from "vitest";
import type { InstitutionalPositioningSummary, ScanResult } from "../shared/types";
import { applyInstitutionalPositioning } from "./scoring";
import {
  createQuantDataPositioningProvider,
  normalizeDarkPool,
  normalizeFlowRanking,
  normalizeIvRank,
  normalizeMaxPain,
  normalizeOpenInterestChange,
  normalizeOptionsExposure,
  normalizeOptionsFlow,
  mostRecentCompletedSessionDate,
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

  it("flags max pain pin risk only when price sits materially above max pain near expiration", () => {
    const pinRisk = normalizeMaxPain({ data: { maxPainStrikePrice: 95 } }, 100, 1);
    const tooFar = normalizeMaxPain({ data: { maxPainStrikePrice: 95 } }, 100, 10);
    const tailwind = normalizeMaxPain({ data: { maxPainStrikePrice: 102 } }, 100, 1);
    const noData = normalizeMaxPain({ data: {} }, 100, 1);

    expect(pinRisk.signal).toBe("pin_risk");
    expect(pinRisk.flags).toContain("Max Pain Pin Risk");
    expect(tooFar.signal).toBe("neutral");
    expect(tailwind.signal).toBe("tailwind");
    expect(noData.signal).toBe("no_data");
  });

  it("reads max pain from a ticker-keyed response envelope", () => {
    const pinRisk = normalizeMaxPain({ data: { AAPL: { maxPainStrikePrice: 95 } } }, 100, 1);
    const tailwind = normalizeMaxPain({ data: { AAPL: { maxPainStrikePrice: 102 } } }, 100, 1);

    expect(pinRisk.signal).toBe("pin_risk");
    expect(tailwind.signal).toBe("tailwind");
  });

  it("computes max pain from the real QuantData intrinsic-value curve (min total intrinsic)", () => {
    // Shape observed live: data -> "<strike>" -> { callIntrinsicValue, putIntrinsicValue }.
    const payload = {
      data: {
        "95.0": { callIntrinsicValue: 5_000, putIntrinsicValue: 60_000 },
        "100.0": { callIntrinsicValue: 20_000, putIntrinsicValue: 20_000 },
        "105.0": { callIntrinsicValue: 70_000, putIntrinsicValue: 5_000 }
      }
    };
    const tailwind = normalizeMaxPain(payload, 99, 1);
    const pinRisk = normalizeMaxPain(payload, 110, 1);

    // Min total intrinsic is at 100 (45k) -> max pain strike 100.
    expect(tailwind.detail).toContain("$100.00");
    expect(tailwind.signal).toBe("tailwind");
    expect(pinRisk.signal).toBe("pin_risk");
  });

  it("reads max pain from the real QuantData cents-denominated response", () => {
    const pinRisk = normalizeMaxPain({ response: { strikePriceInCentsWithMaxPain: 9500, stockPriceInCents: 10000 } }, 100, 1);
    const tailwind = normalizeMaxPain({ response: { strikePriceInCentsWithMaxPain: 10200, stockPriceInCents: 10000 } }, 100, 1);
    const noData = normalizeMaxPain({ response: { strikePriceInCentsWithMaxPain: 0 } }, 100, 1);

    expect(pinRisk.signal).toBe("pin_risk");
    expect(pinRisk.detail).toContain("$95.00");
    expect(tailwind.signal).toBe("tailwind");
    expect(noData.signal).toBe("no_data");
  });

  it("confirms fresh call open interest builds but not same-day noise", () => {
    const confirmed = normalizeOpenInterestChange({
      data: [
        { strike: 102, previousOpenInterest: 4_000, currentOpenInterest: 4_800, changeInOpenInterest: 800 },
        { strike: 105, previousOpenInterest: 3_000, currentOpenInterest: 3_100, changeInOpenInterest: 100 }
      ]
    }, 100);
    const noConfirmation = normalizeOpenInterestChange({
      data: [{ strike: 102, previousOpenInterest: 10_000, currentOpenInterest: 10_050, changeInOpenInterest: 50 }]
    }, 100);
    const noData = normalizeOpenInterestChange({ data: [] }, 100);

    expect(confirmed.signal).toBe("confirmed_build");
    expect(confirmed.flags).toContain("Confirmed Call OI Build");
    expect(noConfirmation.signal).toBe("no_confirmation");
    expect(noData.signal).toBe("no_data");
  });

  it("confirms call OI builds from the real QuantData response list with cents strikes", () => {
    const confirmed = normalizeOpenInterestChange({
      response: [
        { strikePriceInCents: 10200, contractType: "CALL", previousOpenInterest: 4_000, currentOpenInterest: 4_800, changeInOpenInterest: 800 },
        { strikePriceInCents: 10500, contractType: "CALL", previousOpenInterest: 3_000, currentOpenInterest: 3_100, changeInOpenInterest: 100 }
      ]
    }, 100);

    expect(confirmed.signal).toBe("confirmed_build");
    expect(confirmed.flags).toContain("Confirmed Call OI Build");
  });

  it("confirms call OI builds from a ticker-keyed, strike-mapped response envelope", () => {
    const confirmed = normalizeOpenInterestChange({
      data: {
        AAPL: {
          "102": { strike: 102, previousOpenInterest: 4_000, currentOpenInterest: 4_800, changeInOpenInterest: 800 },
          "105": { strike: 105, previousOpenInterest: 3_000, currentOpenInterest: 3_100, changeInOpenInterest: 100 }
        }
      }
    }, 100);

    expect(confirmed.signal).toBe("confirmed_build");
    expect(confirmed.flags).toContain("Confirmed Call OI Build");
  });

  it("cross-checks IV Rank against Compression Quality instead of scoring it standalone", () => {
    const confirming = normalizeIvRank({ data: { lastIv: 0.2, windowMin: 0.15, windowMax: 0.65 } }, true);
    const contradicting = normalizeIvRank({ data: { lastIv: 0.6, windowMin: 0.15, windowMax: 0.65 } }, true);
    const neutralWhenNotCompressing = normalizeIvRank({ data: { lastIv: 0.2, windowMin: 0.15, windowMax: 0.65 } }, false);
    const noData = normalizeIvRank({ data: {} }, true);

    expect(confirming.signal).toBe("confirming");
    expect(confirming.flags).toContain("IV Rank Confirms Compression");
    expect(contradicting.signal).toBe("contradicting");
    expect(neutralWhenNotCompressing.signal).toBe("neutral");
    expect(noData.signal).toBe("no_data");
  });

  it("reads IV Rank from a ticker-keyed response envelope", () => {
    const confirming = normalizeIvRank({ data: { AAPL: { lastIv: 0.2, windowMin: 0.15, windowMax: 0.65 } } }, true);
    const contradicting = normalizeIvRank({ data: { AAPL: { lastIv: 0.6, windowMin: 0.15, windowMax: 0.65 } } }, true);

    expect(confirming.signal).toBe("confirming");
    expect(contradicting.signal).toBe("contradicting");
  });

  it("reads IV Rank from the real QuantData sessionDateToIVRankData shape, using the latest session and CALL", () => {
    const build = (lastIV: number) => ({
      response: {
        sessionDateToIVRankData: {
          "2026-06-26": { contractTypeToIVData: { CALL: { lastIV: 0.9, windowMinIV: 0.15, windowMaxIV: 0.65 } } },
          "2026-06-29": { contractTypeToIVData: { CALL: { lastIV, windowMinIV: 0.15, windowMaxIV: 0.65 }, PUT: { lastIV: 0.5, windowMinIV: 0.1, windowMaxIV: 0.9 } } }
        }
      }
    });

    expect(normalizeIvRank(build(0.2), true).signal).toBe("confirming");
    expect(normalizeIvRank(build(0.6), true).signal).toBe("contradicting");
    expect(normalizeIvRank({ response: { sessionDateToIVRankData: {} } }, true).signal).toBe("no_data");
  });

  it("reads IV Rank from the real QuantData date-keyed response (lastIv/windowMinIv/windowMaxIv)", () => {
    // Shape observed live: data -> "<date>" -> { contractTypeToIVData: { CALL: {...} }, ... }.
    const payload = {
      data: {
        "2026-03-30": { contractTypeToIVData: { CALL: { lastIv: 59.7, windowMinIv: 24.3, windowMaxIv: 69.6 } }, expirationDate: "2026-05-01", stockPrice: 1254.05 },
        "2026-04-07": { contractTypeToIVData: { CALL: { lastIv: 30.0, windowMinIv: 24.3, windowMaxIv: 69.6 }, PUT: { lastIv: 40, windowMinIv: 26, windowMaxIv: 75 } }, expirationDate: "2026-05-08", stockPrice: 1300 }
      }
    };
    // Latest session (2026-04-07) CALL: (30-24.3)/(69.6-24.3) = 0.126 -> bottom third.
    expect(normalizeIvRank(payload, true).signal).toBe("confirming");
    expect(normalizeIvRank(payload, false).signal).toBe("neutral");
  });

  it("reads options exposure from the real QuantData cents-strike contract exposure map", () => {
    const supportive = normalizeOptionsExposure({
      response: {
        stockPriceInCents: 10000,
        expirationDateToStrikePriceInCentsToContractExposureMap: {
          "2026-07-17": {
            "9750": { PUT: -180_000 },
            "10500": { CALL: 60_000 }
          }
        }
      }
    }, 100);
    const hostile = normalizeOptionsExposure({
      response: {
        stockPriceInCents: 10000,
        expirationDateToStrikePriceInCentsToContractExposureMap: {
          "2026-07-17": {
            "10100": { CALL: 250_000 },
            "9750": { PUT: -40_000 }
          }
        }
      }
    }, 100);

    expect(supportive.signal).toBe("squeeze_prone");
    expect(supportive.flags).toContain("Put Support Below Price");
    expect(hostile.signal).toBe("hostile");
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

  it("confirms a clean high-B setup without promoting when confluence is thin", () => {
    const result = applyInstitutionalPositioning(
      baseResult(88, "B"),
      positioning("confirmed", ["Bullish Flow Confirmation"], { confirmingFactorCount: 2 })
    );

    expect(result.grade).toBe("B");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.strongLongCallCandidate).toBe(false);
    expect(result.institutionalPromotionApplied).toBe(false);
  });

  it("promotes a clean high-B setup to A on multi-factor QuantData confluence", () => {
    const result = applyInstitutionalPositioning(
      baseResult(88, "B"),
      positioning("confirmed", ["Bullish Flow Confirmation"], { confirmingFactorCount: 3, vetoingFactorCount: 0 })
    );

    expect(result.gradeBeforeQuantData).toBe("B");
    expect(result.grade).toBe("A");
    expect(result.finalGrade).toBe("A");
    expect(result.institutionalPromotionApplied).toBe(true);
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.strongLongCallCandidate).toBe(true);
    expect(result.flags).toContain("QuantData Grade Promotion");
  });

  it("never promotes an A-grade setup or a setup the technical gate already rejected", () => {
    const alreadyA = applyInstitutionalPositioning(
      baseResult(95, "A"),
      positioning("confirmed", [], { confirmingFactorCount: 4, vetoingFactorCount: 0 })
    );
    const avoided = applyInstitutionalPositioning(
      baseResult(60, "C"),
      positioning("confirmed", [], { confirmingFactorCount: 4, vetoingFactorCount: 0 })
    );

    expect(alreadyA.grade).toBe("A");
    expect(alreadyA.institutionalPromotionApplied).toBe(false);
    expect(avoided.institutionalPromotionApplied).toBe(false);
    expect(avoided.grade).toBe("C");
  });

  it("does not promote when any factor vetoes even with 3+ confirmations", () => {
    const result = applyInstitutionalPositioning(
      baseResult(88, "B"),
      positioning("confirmed", [], { confirmingFactorCount: 4, vetoingFactorCount: 1 })
    );

    expect(result.grade).toBe("B");
    expect(result.institutionalPromotionApplied).toBe(false);
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

  it("warns when order-flow-consolidated rows have none of the recognized fields", async () => {
    const cache: QuantDataCache = { responses: {} };
    const provider = createQuantDataPositioningProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
      maxCalls: 10,
      cache,
      now: () => new Date("2026-06-30T15:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.includes("order-flow/consolidated")) {
          return new Response(JSON.stringify({ data: [{ tradeSideCode: "A", tradeConsolidationType: "SWEEP", isOpeningPosition: true }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
    });

    const result = await provider.enrich("AAPL", 100);

    expect(result.warnings.some((warning) => warning.includes("order-flow-consolidated shape unrecognized"))).toBe(true);
  });

  it("only reaches Confirmed status when Net Drift/Order Flow sentiment is corroborated by an OI build", async () => {
    const bullishFixtures: Record<string, unknown> = {
      "net-drift": { data: { "1": { netCallPremium: 200_000, netPutPremium: 20_000 } } },
      "order-flow-consolidated": { data: [] },
      "exposure-by-strike": {
        data: { AAPL: { exposureMap: { "2026-07-17": { "97.5": { putExposure: -180_000 } } } } }
      },
      "dark-pool-levels": { data: { "99.50": { notionalValue: 12_000_000 } } },
      "iv-rank": { data: { lastIv: 0.2, windowMin: 0.15, windowMax: 0.65 } }
    };

    async function runWithOiChange(oiChangeFixture: unknown) {
      const cache: QuantDataCache = { responses: {} };
      const provider = createQuantDataPositioningProvider({
        apiKey: "test-key",
        baseUrl: "https://api.example.test",
        maxCalls: 10,
        cache,
        now: () => new Date("2026-06-30T15:00:00.000Z"),
        fetchImpl: async (input) => {
          const url = input.toString();
          const match = Object.keys(bullishFixtures).find((endpoint) => url.includes(endpoint));
          if (url.includes("open-interest-change")) return new Response(JSON.stringify(oiChangeFixture), { status: 200 });
          return new Response(JSON.stringify(match ? bullishFixtures[match] : { data: {} }), { status: 200 });
        }
      });
      return provider.enrich("AAPL", 100, { compressionActive: true });
    }

    const withoutOiBuild = await runWithOiChange({ data: [{ strike: 102, previousOpenInterest: 10_000, changeInOpenInterest: 20 }] });
    const withOiBuild = await runWithOiChange({ data: [{ strike: 102, previousOpenInterest: 4_000, changeInOpenInterest: 800 }] });

    expect(withoutOiBuild.positioning.status).not.toBe("confirmed");
    expect(withoutOiBuild.positioning.confirmingFactorCount).toBe(4);
    expect(withOiBuild.positioning.status).toBe("confirmed");
    expect(withOiBuild.positioning.confirmingFactorCount).toBe(5);
    expect(withOiBuild.positioning.vetoingFactorCount).toBe(0);
  });

  it("ranks symbols by universe-wide gainers/losers premium without treating it as a scoring factor", () => {
    // Confirmed live: gainers-losers is a ticker-keyed object, not an array of
    // ticker/symbol-labeled rows, and rows carry premium (not percentChange).
    const ranking = normalizeFlowRanking(
      { data: { AAPL: { premium: 2_000_000 }, MSFT: { premium: 8_000_000 } } }
    );

    expect(ranking.get("AAPL")).toBeGreaterThan(0);
    expect(ranking.get("MSFT")).toBeGreaterThan(ranking.get("AAPL") ?? 0);
    expect(ranking.get("GOOG")).toBeUndefined();
  });

  it("reorders the scan universe by flow ranking while keeping the full symbol set intact", async () => {
    const cache: QuantDataCache = { responses: {} };
    const provider = createQuantDataPositioningProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
      maxCalls: 10,
      cache,
      now: () => new Date("2026-06-30T15:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.includes("gainers-losers")) return new Response(JSON.stringify({ data: { MSFT: { premium: 9_000_000 } } }), { status: 200 });
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
    });

    const ranked = await provider.rankSymbols(["AAPL", "MSFT", "GOOG"]);

    expect(ranked.symbols).toEqual(["MSFT", "AAPL", "GOOG"]);
    expect(ranked.symbols.sort()).toEqual(["AAPL", "GOOG", "MSFT"]);
  });

  it("does not call the net-flow endpoint for universe ranking (it's a single-underlying time series, not cross-sectional)", async () => {
    const cache: QuantDataCache = { responses: {} };
    const requestedUrls: string[] = [];
    const provider = createQuantDataPositioningProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
      maxCalls: 10,
      cache,
      now: () => new Date("2026-06-30T15:00:00.000Z"),
      fetchImpl: async (input) => {
        requestedUrls.push(input.toString());
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });

    await provider.rankSymbols(["AAPL", "MSFT"]);

    expect(requestedUrls.some((url) => url.includes("net-flow"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("gainers-losers"))).toBe(true);
  });

  it("resolves the previous completed U.S. trading session for options flow", () => {
    expect(previousTradingSessionDate(new Date("2026-06-30T15:00:00.000Z"))).toBe("2026-06-29");
    expect(previousTradingSessionDate(new Date("2026-06-29T15:00:00.000Z"))).toBe("2026-06-26");
    expect(previousTradingSessionDate(new Date("2026-07-06T15:00:00.000Z"))).toBe("2026-07-02");
    expect(previousTradingSessionDate(new Date("2022-01-03T15:00:00.000Z"))).toBe("2021-12-30");
  });

  it("rolls the flow session forward to the just-closed session after the 4pm ET close", () => {
    // Tuesday 2026-06-30 during regular hours (09:35 ET) -> prior session (Mon),
    // so the 8:35am CT / 9:35 ET scan is unchanged.
    expect(mostRecentCompletedSessionDate(new Date("2026-06-30T13:35:00.000Z"))).toBe("2026-06-29");
    // One minute before the close (15:59 ET) still resolves to the prior session.
    expect(mostRecentCompletedSessionDate(new Date("2026-06-30T19:59:00.000Z"))).toBe("2026-06-29");
    // Exactly at the 16:00 ET close -> today's just-closed session.
    expect(mostRecentCompletedSessionDate(new Date("2026-06-30T20:00:00.000Z"))).toBe("2026-06-30");
    // After the close (16:30 ET) -> today. This is the after-hours fix.
    expect(mostRecentCompletedSessionDate(new Date("2026-06-30T20:30:00.000Z"))).toBe("2026-06-30");
    // After close on Friday -> Friday; the weekend then holds that session.
    expect(mostRecentCompletedSessionDate(new Date("2026-06-26T20:30:00.000Z"))).toBe("2026-06-26");
    expect(mostRecentCompletedSessionDate(new Date("2026-06-27T20:30:00.000Z"))).toBe("2026-06-26");
    // Holiday (observed Independence Day, Fri 2026-07-03) -> prior completed session.
    expect(mostRecentCompletedSessionDate(new Date("2026-07-03T20:30:00.000Z"))).toBe("2026-07-02");
  });
});

function positioning(
  status: InstitutionalPositioningSummary["status"],
  flags: string[] = [],
  overrides: Partial<Pick<InstitutionalPositioningSummary, "confirmingFactorCount" | "vetoingFactorCount">> = {}
): InstitutionalPositioningSummary {
  return {
    score: status === "confirmed" ? 92 : status === "neutral" ? 50 : 20,
    optionsFlowSignal: status === "confirmed" ? "bullish" : status === "vetoed" ? "bearish" : "mixed",
    optionsExposureSignal: status === "confirmed" ? "supportive" : status === "capped" ? "hostile" : "neutral",
    darkPoolSignal: status === "confirmed" ? "accumulation" : "neutral",
    maxPainSignal: status === "confirmed" ? "tailwind" : "neutral",
    openInterestChangeSignal: status === "confirmed" ? "confirmed_build" : "no_confirmation",
    ivRankSignal: status === "confirmed" ? "confirming" : "neutral",
    status,
    reason: "QuantData test positioning.",
    flags,
    warnings: [],
    confirmingFactorCount: overrides.confirmingFactorCount ?? (status === "confirmed" ? 4 : 0),
    vetoingFactorCount: overrides.vetoingFactorCount ?? (status === "capped" || status === "vetoed" ? 1 : 0)
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
