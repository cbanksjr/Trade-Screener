import type { DailyEntryQualificationMode, IndicatorSnapshot } from "../shared/types";

export function resolveDailyEntryQualificationMode(
  indicators: Pick<IndicatorSnapshot, "ema8" | "ema21" | "ema34" | "atr14">,
  price: number
): DailyEntryQualificationMode {
  if (price < indicators.ema34) return "none";
  const withinEmaPocket = price >= indicators.ema34 && price <= indicators.ema8;
  const withinOneAtrOfEma21 = indicators.atr14 > 0 && price >= indicators.ema21 && price <= indicators.ema21 + indicators.atr14;
  if (withinEmaPocket || withinOneAtrOfEma21) return "strict";
  if (indicators.atr14 > 0 && price <= indicators.ema21 + indicators.atr14 * 1.5) return "extended";
  return "none";
}

export function dailyEntryDetail(mode: DailyEntryQualificationMode): string {
  if (mode === "strict") return "inside the preferred A-entry zone";
  if (mode === "extended") return "inside the controlled B-entry extension up to 1.5 ATR above the 21 EMA";
  return "below the 34 EMA or more than 1.5 ATR above the 21 EMA";
}
