import { describe, expect, it } from "vitest";
import type { Candle, MacroRegimeLabel } from "../shared/types";
import {
  classifyIndexTrend,
  classifyVixLevel,
  clampScore,
  combineIndexRegime,
  computeMacroRegimeContext,
  moreBearishRegime,
  resolveMacroModifier
} from "./macroRegime";

describe("classifyIndexTrend", () => {
  it("classifies a monotonically rising series as bullish", () => {
    const candles = trendingCandles(220, 0.6, 90);
    const result = classifyIndexTrend(candles, "SPY");
    expect(result.trend).toBe("bullish");
    expect(result.ema20).not.toBeNull();
  });

  it("classifies a monotonically falling series as bearish", () => {
    const candles = trendingCandles(220, -0.6, 90);
    const result = classifyIndexTrend(candles, "SPY");
    expect(result.trend).toBe("bearish");
  });

  it("classifies a choppy/sideways series as neutral", () => {
    const candles = choppyCandles(90);
    const result = classifyIndexTrend(candles, "SPY");
    expect(result.trend).toBe("neutral");
  });

  it("treats insufficient history as neutral with null EMAs", () => {
    const result = classifyIndexTrend(trendingCandles(220, 0.6, 30), "SPY");
    expect(result.trend).toBe("neutral");
    expect(result.ema20).toBeNull();
    expect(result.ema50).toBeNull();
    expect(result.ema200).toBeNull();
  });

  it("treats missing candles as neutral", () => {
    const result = classifyIndexTrend(undefined, "QQQ");
    expect(result.trend).toBe("neutral");
    expect(result.detail).toContain("QQQ");
  });
});

describe("classifyVixLevel", () => {
  it("classifies just below the low threshold as low", () => {
    expect(classifyVixLevel(14.99).regime).toBe("low");
  });

  it("classifies exactly the low threshold as rising", () => {
    expect(classifyVixLevel(15).regime).toBe("rising");
  });

  it("classifies exactly the elevated threshold as rising", () => {
    expect(classifyVixLevel(25).regime).toBe("rising");
  });

  it("classifies just above the elevated threshold as elevated", () => {
    expect(classifyVixLevel(25.01).regime).toBe("elevated");
  });

  it("falls back to low when VIX is unavailable", () => {
    const result = classifyVixLevel(undefined);
    expect(result.regime).toBe("low");
    expect(result.detail).toContain("unavailable");
  });
});

describe("combineIndexRegime", () => {
  it("passes through bearish trend regardless of VIX", () => {
    expect(combineIndexRegime("bearish", "low", "SPY").regime).toBe("bearish");
    expect(combineIndexRegime("bearish", "rising", "SPY").regime).toBe("bearish");
    expect(combineIndexRegime("bearish", "elevated", "SPY").regime).toBe("bearish");
  });

  it("passes through neutral trend regardless of VIX", () => {
    expect(combineIndexRegime("neutral", "low", "SPY").regime).toBe("neutral");
    expect(combineIndexRegime("neutral", "rising", "SPY").regime).toBe("neutral");
    expect(combineIndexRegime("neutral", "elevated", "SPY").regime).toBe("neutral");
  });

  it("keeps bullish trend as bullish when VIX is low or rising", () => {
    expect(combineIndexRegime("bullish", "low", "SPY").regime).toBe("bullish");
    expect(combineIndexRegime("bullish", "rising", "SPY").regime).toBe("bullish");
  });

  it("downgrades bullish trend to neutral when VIX is elevated", () => {
    expect(combineIndexRegime("bullish", "elevated", "SPY").regime).toBe("neutral");
  });
});

describe("moreBearishRegime", () => {
  const cases: [MacroRegimeLabel, MacroRegimeLabel, MacroRegimeLabel][] = [
    ["bullish", "neutral", "neutral"],
    ["neutral", "bullish", "neutral"],
    ["neutral", "bearish", "bearish"],
    ["bearish", "neutral", "bearish"],
    ["bullish", "bearish", "bearish"],
    ["bearish", "bullish", "bearish"],
    ["bullish", "bullish", "bullish"]
  ];

  it.each(cases)("moreBearishRegime(%s, %s) => %s", (a, b, expected) => {
    expect(moreBearishRegime(a, b)).toBe(expected);
  });
});

describe("computeMacroRegimeContext", () => {
  it("resolves a bullish effective regime when SPY and QQQ both agree and VIX is low", () => {
    const context = computeMacroRegimeContext({
      spyCandles: trendingCandles(220, 0.6, 90),
      qqqCandles: trendingCandles(350, 0.9, 90),
      vixLevel: 12
    });
    expect(context.spy.regime).toBe("bullish");
    expect(context.qqq.regime).toBe("bullish");
    expect(context.effectiveRegime).toBe("bullish");
    expect(context.warnings).toEqual([]);
  });

  it("uses the more-bearish regime when SPY and QQQ disagree", () => {
    const context = computeMacroRegimeContext({
      spyCandles: trendingCandles(220, 0.6, 90),
      qqqCandles: trendingCandles(350, -0.9, 90),
      vixLevel: 12
    });
    expect(context.spy.regime).toBe("bullish");
    expect(context.qqq.regime).toBe("bearish");
    expect(context.effectiveRegime).toBe("bearish");
  });

  it("falls back to low/neutral with a warning when VIX is missing", () => {
    const context = computeMacroRegimeContext({
      spyCandles: trendingCandles(220, 0.6, 90),
      qqqCandles: trendingCandles(350, 0.9, 90),
      vixLevel: undefined
    });
    expect(context.vix.regime).toBe("low");
    expect(context.warnings.some((warning) => warning.toLowerCase().includes("vix"))).toBe(true);
  });

  it("treats missing SPY/QQQ candles as neutral with warnings", () => {
    const context = computeMacroRegimeContext({ vixLevel: 12 });
    expect(context.spy.trend).toBe("neutral");
    expect(context.qqq.trend).toBe("neutral");
    expect(context.effectiveRegime).toBe("neutral");
    expect(context.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveMacroModifier", () => {
  it("applies no discount to a long setup in a bullish regime", () => {
    expect(resolveMacroModifier("long", "bullish")).toEqual({ modifier: 1, counterTrend: false });
  });

  it("applies no discount to a long setup in a neutral regime", () => {
    expect(resolveMacroModifier("long", "neutral")).toEqual({ modifier: 1, counterTrend: false });
  });

  it("applies the counter-trend discount to a long setup in a bearish regime", () => {
    expect(resolveMacroModifier("long", "bearish")).toEqual({ modifier: 0.7, counterTrend: true });
  });

  it("applies no discount to a short setup in a bearish regime (unreachable in this codebase)", () => {
    expect(resolveMacroModifier("short", "bearish")).toEqual({ modifier: 1, counterTrend: false });
  });

  it("applies the counter-trend discount to a short setup in a bullish regime (unreachable in this codebase)", () => {
    expect(resolveMacroModifier("short", "bullish")).toEqual({ modifier: 0.7, counterTrend: true });
  });
});

describe("clampScore", () => {
  it("clamps above 100 down to 100", () => {
    expect(clampScore(150)).toBe(100);
  });

  it("clamps below 0 up to 0", () => {
    expect(clampScore(-10)).toBe(0);
  });

  it("leaves in-range values unchanged", () => {
    expect(clampScore(55)).toBe(55);
  });
});

function trendingCandles(start: number, step: number, length: number): Candle[] {
  return Array.from({ length }, (_, index) => {
    const close = start + index * step;
    return {
      date: "2026-01-" + String((index % 28) + 1).padStart(2, "0"),
      open: close - step / 2,
      high: close + Math.abs(step),
      low: close - Math.abs(step),
      close,
      volume: 50_000_000
    };
  });
}

function choppyCandles(length: number): Candle[] {
  return Array.from({ length }, (_, index) => {
    const close = 200;
    return {
      date: "2026-01-" + String((index % 28) + 1).padStart(2, "0"),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 50_000_000
    };
  });
}
