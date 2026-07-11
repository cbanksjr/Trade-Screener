import type { DailyEntryQualificationMode, IndicatorSnapshot } from "../shared/types";

export function resolveDailyEntryQualificationMode(
  indicators: Pick<IndicatorSnapshot, "ema21" | "atr14">,
  price: number
): DailyEntryQualificationMode {
  if (indicators.atr14 <= 0 || price < indicators.ema21) return "none";
  if (price <= indicators.ema21 + indicators.atr14) return "strict";
  if (price <= indicators.ema21 + indicators.atr14 * 1.5) return "extended";
  return "none";
}

export function dailyEntryDetail(mode: DailyEntryQualificationMode): string {
  if (mode === "strict") return "inside the preferred A-entry zone";
  if (mode === "extended") return "inside the controlled B-entry extension up to 1.5 ATR above the 21 EMA";
  return "below the 21 EMA or more than 1.5 ATR above it";
}
