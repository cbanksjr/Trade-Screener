import { describe, expect, it } from "vitest";
import type { OptionContract } from "../shared/types";
import {
  analyzeOptionsActivity,
  calculateGammaWalls,
  calculateMaxPain,
  createSchwabPositioningProvider,
  evaluateOpenInterestBuild,
  observationSessionDate,
  type SchwabPositioningCache,
  type SchwabPositioningSessionSnapshot
} from "./schwabPositioning";

function option(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: "TEST  260821C00100000",
    description: "TEST Aug 21 2026 100 Call",
    expirationDate: "2026-08-21",
    strike: 100,
    optionType: "call",
    bid: 1.9,
    ask: 2.1,
    last: 2,
    volume: 1_000,
    openInterest: 10_000,
    delta: 0.5,
    gamma: 0.02,
    impliedVolatility: 0.3,
    dte: 37,
    spreadPct: 10,
    score: 50,
    ...overrides
  };
}

function positioningChain(callOpenInterest = 10_000): OptionContract[] {
  return [
    option({
      symbol: "TEST  260821C00105000",
      strike: 105,
      volume: 1_000,
      openInterest: callOpenInterest,
      gamma: 0.02,
      bid: 1.9,
      ask: 2.1
    }),
    option({
      symbol: "TEST  260821P00095000",
      description: "TEST Aug 21 2026 95 Put",
      optionType: "put",
      strike: 95,
      volume: 50,
      openInterest: 20_000,
      gamma: 0.1,
      bid: 0.9,
      ask: 1.1
    })
  ];
}

describe("Schwab options positioning calculations", () => {
  it("calculates gross call/put activity, premium, and volume/OI without claiming trade direction", () => {
    const activity = analyzeOptionsActivity([
      option({ volume: 1_000, openInterest: 4_000, bid: 1.9, ask: 2.1 }),
      option({
        symbol: "TEST  260821P00100000",
        optionType: "put",
        volume: 200,
        openInterest: 2_000,
        bid: 0.9,
        ask: 1.1
      })
    ]);

    expect(activity.callVolume).toBe(1_000);
    expect(activity.putVolume).toBe(200);
    expect(activity.callPremium).toBe(200_000);
    expect(activity.putPremium).toBe(20_000);
    expect(activity.callVolumeToOpenInterest).toBe(0.25);
    expect(activity.putVolumeToOpenInterest).toBe(0.1);
    expect(activity.signal).toBe("bullish");
    expect(activity.detail).toContain("not aggressor-side flow");
  });

  it("deduplicates repeated contracts before aggregating activity", () => {
    const contract = option({ volume: 400, openInterest: 2_000 });
    const activity = analyzeOptionsActivity([contract, { ...contract }]);

    expect(activity.callVolume).toBe(400);
    expect(activity.callOpenInterest).toBe(2_000);
  });

  it("reports volume/OI as unavailable when open interest is missing", () => {
    const activity = analyzeOptionsActivity([option({ openInterest: 0, volume: 400 })]);

    expect(activity.callVolumeToOpenInterest).toBeUndefined();
    expect(activity.detail).toContain("volume/OI N/A");
  });

  it("treats put-heavy same-day activity as mixed rather than a bearish veto signal", () => {
    const activity = analyzeOptionsActivity([
      option({ volume: 100, bid: 0.9, ask: 1.1 }),
      option({
        symbol: "TEST  260821P00100000",
        optionType: "put",
        volume: 1_000,
        bid: 2.9,
        ask: 3.1
      })
    ]);

    expect(activity.signal).toBe("mixed");
    expect(activity.flags).toContain("Put-Skewed Options Activity");
  });

  it("computes unsigned gamma walls using the documented one-percent-move formula", () => {
    const analysis = calculateGammaWalls(positioningChain(), 100);

    // Put: .10 gamma × 20k OI × 100 multiplier × 100² spot × 1% = $20m.
    expect(analysis.putConcentration).toEqual({ strike: 95, dollarGammaPerOnePercentMove: 20_000_000 });
    expect(analysis.callConcentration).toEqual({ strike: 105, dollarGammaPerOnePercentMove: 2_000_000 });
    expect(analysis.signal).toBe("neutral");
    expect(analysis.detail).toContain("Dealer sign is unknown");
  });

  it("keeps an overhead call gamma concentration neutral because Schwab lacks dealer sign", () => {
    const analysis = calculateGammaWalls([
      option({ strike: 101, gamma: 0.2, openInterest: 20_000 }),
      option({ symbol: "PUT", optionType: "put", strike: 95, gamma: 0.01, openInterest: 100 })
    ], 100);

    expect(analysis.signal).toBe("neutral");
    expect(analysis.flags).toContain("Call Gamma Concentration Near Price");
  });

  it("calculates max pain as the settlement strike with minimum aggregate OI payout", () => {
    const rows = [
      option({ symbol: "C90", strike: 90, openInterest: 100, volume: 0 }),
      option({ symbol: "C100", strike: 100, openInterest: 50, volume: 0 }),
      option({ symbol: "P100", optionType: "put", strike: 100, openInterest: 50, volume: 0 }),
      option({ symbol: "P110", optionType: "put", strike: 110, openInterest: 100, volume: 0 })
    ];
    const analysis = calculateMaxPain(rows, 98, "2026-08-21");

    expect(analysis.strike).toBe(100);
    expect(analysis.signal).toBe("neutral");
    expect(analysis.detail).toContain("bounded returned strike window");
  });

  it("returns no max-pain signal when an expiration lacks one side of open interest", () => {
    const analysis = calculateMaxPain([option()], 100, "2026-08-21");

    expect(analysis.signal).toBe("no_data");
  });
});

describe("Schwab OI snapshots", () => {
  const snapshot = (
    sessionDate: string,
    callOpenInterest: number,
    observedAt = sessionDate + "T15:00:00.000Z",
    callContracts: Record<string, number> = { CALL: callOpenInterest }
  ): SchwabPositioningSessionSnapshot => ({
    sessionDate,
    observedAt,
    callOpenInterest,
    callContracts
  });

  it("requires a distinct prior session and conservative absolute/percentage thresholds", () => {
    expect(evaluateOpenInterestBuild(snapshot("2026-07-15", 10_600), snapshot("2026-07-15", 10_000)).signal).toBe("no_data");
    expect(evaluateOpenInterestBuild(snapshot("2026-07-16", 10_400), snapshot("2026-07-15", 10_000)).signal).toBe("no_confirmation");
    expect(evaluateOpenInterestBuild(snapshot("2026-07-16", 10_600), snapshot("2026-07-15", 10_000))).toMatchObject({
      signal: "confirmed_build",
      change: 600,
      percentChange: 6
    });
  });

  it("requires the immediately preceding trading session", () => {
    expect(evaluateOpenInterestBuild(
      snapshot("2026-07-20", 11_000),
      snapshot("2026-07-16", 10_000)
    ).signal).toBe("no_data");
    expect(evaluateOpenInterestBuild(
      snapshot("2026-07-20", 11_000),
      snapshot("2026-07-17", 10_000)
    ).signal).toBe("confirmed_build");
  });

  it("compares only the fixed prior-session cohort and rejects low coverage", () => {
    const prior = snapshot("2026-07-15", 10_000, undefined, { A: 7_000, B: 3_000 });
    const newContractOnly = snapshot("2026-07-16", 12_000, undefined, { A: 7_000, B: 3_000, NEW: 2_000 });
    expect(evaluateOpenInterestBuild(newContractOnly, prior).signal).toBe("no_confirmation");

    const lowCoverage = snapshot("2026-07-16", 13_000, undefined, { B: 4_000, NEW: 9_000 });
    expect(evaluateOpenInterestBuild(lowCoverage, prior)).toMatchObject({
      signal: "no_data",
      change: 0
    });
  });

  it("uses the New York observation date and folds closed-market dates into the prior session", () => {
    expect(observationSessionDate(new Date("2026-07-16T01:00:00.000Z"))).toBe("2026-07-15");
    expect(observationSessionDate(new Date("2026-07-19T15:00:00.000Z"))).toBe("2026-07-17");
    expect(observationSessionDate(new Date("2026-07-03T15:00:00.000Z"))).toBe("2026-07-02");
  });

  it("never confirms same-day activity, replaces same-session snapshots, and confirms on a later OI build", async () => {
    let currentTime = new Date("2026-07-15T15:00:00.000Z");
    let callOpenInterest = 10_000;
    const provider = createSchwabPositioningProvider({
      now: () => currentTime,
      loadChain: async () => positioningChain(callOpenInterest)
    });

    const first = await provider.enrich("test", 100);
    expect(first.positioning.status).toBe("neutral");
    expect(first.positioning.openInterestChangeSignal).toBe("no_data");
    expect(first.positioning.availability).toBe("awaiting_oi_comparison");

    callOpenInterest = 10_200;
    const sameSession = await provider.enrich("TEST", 100);
    expect(sameSession.positioning.status).toBe("neutral");
    expect(sameSession.positioning.openInterestChangeSignal).toBe("no_data");
    expect(provider.cache().symbols.TEST.sessions).toHaveLength(1);
    expect(provider.cache().symbols.TEST.sessions[0].callOpenInterest).toBe(10_200);

    currentTime = new Date("2026-07-16T15:00:00.000Z");
    callOpenInterest = 11_200;
    const nextSession = await provider.enrich("TEST", 100);
    expect(nextSession.positioning.openInterestChangeSignal).toBe("confirmed_build");
    expect(nextSession.positioning.status).toBe("confirmed");
    expect(nextSession.positioning.availability).toBe("available");
    expect(nextSession.positioning.vetoingFactorCount).toBe(0);
    expect(nextSession.positioning.darkPoolSignal).toBe("no_data");
    expect(nextSession.positioning.ivRankSignal).toBe("no_data");
  });

  it("keeps only the latest two sessions per symbol and applies the overall symbol bound", async () => {
    let currentTime = new Date("2026-07-14T15:00:00.000Z");
    const provider = createSchwabPositioningProvider({
      now: () => currentTime,
      maxCacheSymbols: 2,
      loadChain: async () => positioningChain()
    });

    await provider.enrich("AAA", 100);
    currentTime = new Date("2026-07-15T15:00:00.000Z");
    await provider.enrich("AAA", 100);
    currentTime = new Date("2026-07-16T15:00:00.000Z");
    await provider.enrich("AAA", 100);
    currentTime = new Date("2026-07-16T16:00:00.000Z");
    await provider.enrich("BBB", 100);
    currentTime = new Date("2026-07-17T15:00:00.000Z");
    await provider.enrich("CCC", 100);

    expect(provider.cache().symbols.AAA).toBeUndefined();
    expect(Object.keys(provider.cache().symbols)).toEqual(["CCC", "BBB"]);
    expect(provider.cache().symbols.BBB.sessions).toHaveLength(1);
  });

  it("prunes oversized cache input to two distinct sessions with bounded OI cohorts", () => {
    const cache: SchwabPositioningCache = {
      version: 2,
      symbols: {
        TEST: {
          updatedAt: "2026-07-16T16:00:00.000Z",
          sessions: [
            snapshot("2026-07-14", 9_000),
            snapshot("2026-07-15", 10_000, "2026-07-15T14:00:00.000Z"),
            snapshot("2026-07-15", 10_100, "2026-07-15T16:00:00.000Z"),
            snapshot("2026-07-16", 11_000)
          ]
        }
      }
    };
    const provider = createSchwabPositioningProvider({ cache, loadChain: async () => [] });

    expect(provider.cache().symbols.TEST.sessions.map((item) => item.sessionDate)).toEqual(["2026-07-15", "2026-07-16"]);
    expect(provider.cache().symbols.TEST.sessions[0].callOpenInterest).toBe(10_100);
    expect(Object.keys(provider.cache().symbols.TEST.sessions[0].callContracts)).toHaveLength(1);
    expect(JSON.stringify(provider.cache())).not.toContain("description");
  });

  it("fails neutrally without mutating snapshots when Schwab errors or returns no chain", async () => {
    const failing = createSchwabPositioningProvider({
      loadChain: async () => { throw new Error("temporary Schwab failure"); }
    });
    const failed = await failing.enrich("TEST", 100);
    expect(failed.usedLive).toBe(true);
    expect(failed.positioning.status).toBe("neutral");
    expect(failed.positioning.availability).toBe("provider_error");
    expect(failed.positioning.vetoingFactorCount).toBe(0);
    expect(failed.warnings).toContain("temporary Schwab failure");
    expect(failing.isDirty()).toBe(false);

    const empty = createSchwabPositioningProvider({ loadChain: async () => [] });
    const noChain = await empty.enrich("TEST", 100);
    expect(noChain.positioning.optionsFlowSignal).toBe("neutral");
    expect(noChain.positioning.openInterestChangeSignal).toBe("no_data");
    expect(noChain.positioning.availability).toBe("no_chain");
    expect(empty.isDirty()).toBe(false);
  });

  it("reuses a supplied chain without making another provider request", () => {
    let loadCalls = 0;
    const provider = createSchwabPositioningProvider({
      loadChain: async () => {
        loadCalls += 1;
        return positioningChain();
      }
    });

    const result = provider.enrichFromContracts("TEST", 100, positioningChain());

    expect(loadCalls).toBe(0);
    expect(result.usedLive).toBe(true);
    expect(result.positioning.optionsFlowSignal).toBe("bullish");
  });
});
