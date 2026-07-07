import { describe, expect, it } from "vitest";
import type { MacroRegimeLabel, ScanResult } from "../shared/types";
import type { MacroRegimeContext } from "./macroRegime";
import { applyMacroRegimeModifier } from "./scoring";

describe("applyMacroRegimeModifier", () => {
  it("applies no discount and no counter-trend flag in a bullish regime", () => {
    const base = baseResult(100, "A");
    const result = applyMacroRegimeModifier(base, macroContext("bullish"));

    expect(result.finalScore).toBe(100);
    expect(result.counterTrend).toBe(false);
    expect(result.macroModifierApplied).toBe(1);
    expect(result.flags ?? []).not.toContain("Counter-Trend");
    expect(result.macroRegimeQqq).toBe("bullish");
    expect(result.macroRegimeSpy).toBe("bullish");
    expect(result.effectiveMacroRegime).toBe("bullish");
  });

  it("applies no discount in a neutral regime", () => {
    const base = baseResult(80, "B");
    const result = applyMacroRegimeModifier(base, macroContext("neutral"));

    expect(result.finalScore).toBe(80);
    expect(result.counterTrend).toBe(false);
    expect(result.macroModifierApplied).toBe(1);
  });

  it("applies the counter-trend discount and flag in a bearish regime", () => {
    const base = baseResult(100, "A");
    const result = applyMacroRegimeModifier(base, macroContext("bearish"));

    expect(result.finalScore).toBe(70);
    expect(result.counterTrend).toBe(true);
    expect(result.macroModifierApplied).toBe(0.7);
    expect(result.flags).toContain("Counter-Trend");
    expect(result.flags?.filter((flag) => flag === "Counter-Trend")).toHaveLength(1);
  });

  it("does not duplicate the Counter-Trend flag when applied twice", () => {
    const base = baseResult(100, "A");
    const once = applyMacroRegimeModifier(base, macroContext("bearish"));
    const twice = applyMacroRegimeModifier(once, macroContext("bearish"));

    expect(twice.flags?.filter((flag) => flag === "Counter-Trend")).toHaveLength(1);
  });

  it("clamps a low base score to a non-negative final score", () => {
    const base = baseResult(5, "C");
    const result = applyMacroRegimeModifier(base, macroContext("bearish"));

    expect(result.finalScore).toBe(4);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
  });

  it("never changes grade, tradeMark, longCallDecision, or passesUniverse", () => {
    for (const regime of ["bullish", "neutral", "bearish"] as MacroRegimeLabel[]) {
      const base = baseResult(88, "B");
      const result = applyMacroRegimeModifier(base, macroContext(regime));

      expect(result.grade).toBe(base.grade);
      expect(result.tradeMark).toBe(base.tradeMark);
      expect(result.longCallDecision).toBe(base.longCallDecision);
      expect(result.passesUniverse).toBe(base.passesUniverse);
    }
  });

  it("updates macroRegimeSummary to the new regime narrative", () => {
    const base = baseResult(100, "A");
    const context = macroContext("bearish");
    const result = applyMacroRegimeModifier(base, context);

    expect(result.macroRegimeSummary).toBe(context.detail);
  });
});

function macroContext(effectiveRegime: MacroRegimeLabel): MacroRegimeContext {
  return {
    spy: { trend: effectiveRegime, regime: effectiveRegime, detail: "SPY regime " + effectiveRegime + "." },
    qqq: { trend: effectiveRegime, regime: effectiveRegime, detail: "QQQ regime " + effectiveRegime + "." },
    vix: { level: 14, regime: "low", detail: "VIX at 14.00 is below 15 (low)." },
    effectiveRegime,
    detail: "Effective macro regime is " + effectiveRegime + ".",
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
    tradeMark: "Take",
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
