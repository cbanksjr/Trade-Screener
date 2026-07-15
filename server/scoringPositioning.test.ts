import { describe, expect, it } from "vitest";
import type { OptionsPositioningSummary, ScanResult } from "../shared/types";
import { applySchwabPositioning } from "./scoring";

describe("Schwab options positioning overlay", () => {
  it("confirms without changing the technical grade", () => {
    const result = applySchwabPositioning(baseResult("B"), positioning("confirmed"));

    expect(result.grade).toBe("B");
    expect(result.finalGrade).toBe("B");
    expect(result.gradeBeforePositioning).toBe("B");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Moderate Long Call Candidate");
    expect(result.positioningPromotionApplied).toBe(false);
    expect(result.optionsPositioningAvailability).toBe("available");
  });

  it("keeps ambiguous positioning neutral and clears stale provider overlay reasons", () => {
    const result = applySchwabPositioning({
      ...baseResult("A"),
      tradeMark: "Avoid",
      tradeMarkReasons: ["Bearish Flow Veto"],
      flags: ["QuantData Grade Promotion", "Bearish Flow Veto"]
    }, positioning("neutral"));

    expect(result.grade).toBe("A");
    expect(result.tradeMark).toBe("Take");
    expect(result.longCallDecision).toBe("Strong Long Call Candidate");
    expect(result.tradeMarkReasons).toEqual([]);
    expect(result.flags).not.toContain("QuantData Grade Promotion");
    expect(result.flags).not.toContain("Bearish Flow Veto");
  });

  it("does not let bullish positioning erase an independent technical caution", () => {
    const result = applySchwabPositioning({
      ...baseResult("B"),
      tradeMark: "Avoid",
      tradeMarkReasons: ["Option spreads are too wide."]
    }, positioning("confirmed"));

    expect(result.grade).toBe("B");
    expect(result.tradeMark).toBe("Avoid");
    expect(result.tradeMarkReasons).toEqual(["Option spreads are too wide."]);
  });
});

function positioning(status: OptionsPositioningSummary["status"]): OptionsPositioningSummary {
  return {
    score: status === "confirmed" ? 80 : 50,
    optionsFlowSignal: status === "confirmed" ? "bullish" : "mixed",
    optionsExposureSignal: "neutral",
    darkPoolSignal: "no_data",
    maxPainSignal: "neutral",
    openInterestChangeSignal: status === "confirmed" ? "confirmed_build" : "no_confirmation",
    ivRankSignal: "no_data",
    status,
    availability: "available",
    reason: "Schwab options positioning test.",
    flags: [],
    warnings: [],
    confirmingFactorCount: status === "confirmed" ? 2 : 0,
    vetoingFactorCount: 0
  };
}

function baseResult(grade: ScanResult["grade"]): ScanResult {
  return {
    grade,
    setupScore: grade === "A" ? 95 : 85,
    tradeMark: "Take",
    tradeMarkReasons: [],
    longCallDecision: grade === "A" ? "Strong Long Call Candidate" : "Moderate Long Call Candidate",
    compressionQualityStatus: "Bullish",
    gradeCapReasons: [],
    reasonsSupportingTrade: [],
    reasonsAgainstTrade: [],
    warnings: []
  } as unknown as ScanResult;
}
