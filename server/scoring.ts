import type {
  Candle,
  Fundamentals,
  Grade,
  IndicatorSnapshot,
  LayerEvaluation,
  LayerStatus,
  LongCallDecision,
  LowerTimeframeConfluence,
  LowerTimeframeContext,
  OptionContract,
  ScanResult,
  ScoreRule,
  SqueezeState,
  TimeframeSqueezeStatus
} from "../shared/types";
import { activeSqueezeDotCount, latestIndicators, round } from "./indicators";
import { buildTimeframeContext, compressionLayerStatus, compressionQualityScore, hasPositiveEmaStack } from "./timeframes";

const SQUEEZE_STATES: SqueezeState[] = ["low", "mid", "high"];

export const defaultSettings = {
  minPrice: 20,
  minBeta: 0.75,
  minMarketCap: 2_000_000_000,
  minAvgDollarVolume: 600_000_000,
  useDemoDataWhenMissingApi: true
};

export function gradeSetup(input: {
  symbol: string;
  companyName?: string;
  candles: Candle[];
  currentPrice?: number;
  fundamentals?: Fundamentals;
  optionable: boolean;
  options: OptionContract[];
  lowerTimeframes?: LowerTimeframeConfluence;
  lowerTimeframeWarnings?: string[];
  weeklyIndicators?: IndicatorSnapshot;
  weeklySqueezeWarning?: string;
  spyCandles?: Candle[];
  qqqCandles?: Candle[];
  strictFundamentals?: boolean;
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const dailySqueezeDotCount = activeSqueezeDotCount(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = input.currentPrice ?? latest.close;
  const beta = input.fundamentals?.beta;
  const marketCap = input.fundamentals?.marketCap;
  const avgDollarVolume20d = input.fundamentals?.avgDollarVolume20d ?? average(input.candles.slice(-20).map((candle) => candle.volume * candle.close));
  const dailyContext = withCurrentPrice(buildTimeframeContext("daily", input.candles), price);
  const weeklyContext = input.weeklyIndicators ? contextFromIndicators("weekly", input.weeklyIndicators, price) : unavailableContext("weekly", "Weekly context could not be calculated.");
  const lowerTimeframes = input.lowerTimeframes ?? unavailableLowerTimeframes();
  const contexts = [
    lowerTimeframes.thirtyMinute,
    lowerTimeframes.oneHour,
    lowerTimeframes.fourHour,
    dailyContext
  ];
  const weeklySupport = weeklySupportStatus(weeklyContext);
  const options = rankCallOptions(input.options, price);
  const recommendedOption = options[0];
  const institutional = evaluateInstitutional({
    price,
    beta,
    marketCap,
    avgDollarVolume20d,
    optionable: input.optionable,
    strictFundamentals: Boolean(input.strictFundamentals)
  });
  const marketStructure = evaluateMarketStructure(contexts, dailyContext, weeklySupport);
  const optionLayer = evaluateOptions(options);
  const compression = evaluateCompression(contexts, dailyContext, dailySqueezeDotCount);
  const macro = evaluateMacro(input.spyCandles, input.qqqCandles);
  const relativeStrengthSummary = evaluateRelativeStrength(input.candles, input.spyCandles, input.qqqCandles);
  const layerEvaluations = [marketStructure, institutional, optionLayer, macro, compression];
  const decision = finalDecision(layerEvaluations, contexts, dailyContext, weeklySupport);
  const grade = decision === "Strong Long Call Candidate" ? "A" : "B";
  const compressionQualityScoreValue = dailySqueezeDotCount;
  const warnings = input.lowerTimeframeWarnings ?? (input.lowerTimeframes ? [] : ["Lower-timeframe confluence unavailable; 30m/1h/4h rules were not evaluated."]);
  if (input.weeklySqueezeWarning) warnings.push(input.weeklySqueezeWarning);

  return {
    symbol: input.symbol,
    companyName: input.companyName,
    setupDirection: "long",
    dataSource: "demo",
    price,
    beta: beta ?? null,
    marketCap: marketCap ?? null,
    avgDollarVolume20d: round(avgDollarVolume20d, 0),
    optionable: input.optionable,
    passesUniverse: institutional.status !== "Bearish" && institutional.status !== "Insufficient Data",
    grade,
    longCallDecision: decision,
    setupQuality: grade === "A" ? "High" : "Moderate",
    entryRecommendationType: entryType(decision, compression.status),
    score: compressionQualityScoreValue,
    maxScore: 5,
    indicators,
    weeklyIndicators: input.weeklyIndicators,
    lowerTimeframes,
    squeezeStatusByTimeframe: [
      ...contexts.map(toTimeframeStatus),
      toTimeframeStatus(weeklyContext)
    ],
    weeklyContextSummary: weeklySummary(weeklyContext),
    dailySqueezeDotCount,
    compressionQualityScore: compressionQualityScoreValue,
    compressionQualityStatus: compression.status,
    multiTimeframeAlignmentSummary: alignmentSummary(contexts, weeklyContext),
    relativeStrengthSummary,
    institutionalContextSummary: institutional.detail,
    macroRegimeSummary: macro.detail,
    layerEvaluations,
    recommendedOptionContract: recommendedOption,
    recommendedDte: recommendedOption ? optionDteLabel(recommendedOption) : undefined,
    recommendedDelta: recommendedOption?.delta !== undefined ? recommendedOption.delta.toFixed(2) : undefined,
    suggestedEntryArea: suggestedEntry(price, indicators),
    invalidationLevel: invalidation(price, indicators),
    stockStopPrice: round(Math.min(indicators.ema34, indicators.ema55), 2),
    target1: round(price + indicators.atr14 * 1.5, 2),
    target2: round(price + indicators.atr14 * 2.5, 2),
    reasonsSupportingTrade: supportReasons(layerEvaluations, contexts, weeklyContext, recommendedOption),
    reasonsAgainstTrade: riskReasons(layerEvaluations, contexts, weeklyContext, recommendedOption),
    alertMessage: alertMessage(input.symbol, decision, price, dailySqueezeDotCount),
    journalRecord: journalRecord(input.symbol, decision, price, contexts, weeklyContext, recommendedOption),
    rules: layerEvaluations.map(layerToRule),
    suggestedOptions: options.slice(0, 5),
    candles: input.candles.slice(-120),
    lastUpdated: new Date().toISOString(),
    warnings
  };
}

export function isSqueezeActive(state: SqueezeState | undefined): boolean {
  return Boolean(state && SQUEEZE_STATES.includes(state));
}

function evaluateMarketStructure(contexts: LowerTimeframeContext[], dailyContext: LowerTimeframeContext, weeklyStatus: LayerStatus): LayerEvaluation {
  const available = contexts.filter((context) => context.bias !== "unavailable");
  if (available.length < 3) return layer("Squeeze Market Structure", "Insufficient Data", "Not enough selected timeframe data to evaluate structure.");
  const bullish = available.filter((context) => context.bias === "bullish").length;
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  const bearish = available.some((context) => context.bias === "bearish");
  const lowerEntryAligned = available.filter((context) => context.timeframe !== "daily" && context.withinOneAtrOfEma21).length;
  if (!dailySqueezeActive) return layer("Squeeze Market Structure", "Bearish", "Daily squeeze is required for swing setups; daily squeeze state is " + dailyContext.squeezeState + ".");
  if (bullish === available.length && weeklyStatus !== "Bearish") return layer("Squeeze Market Structure", "Bullish", "Daily squeeze is active and all selected lower/daily timeframes have bullish EMA structure. Lower-timeframe 1 ATR alignment is bonus confirmation on " + lowerEntryAligned + " timeframe(s).");
  if (bullish >= 3 && !bearish) return layer("Squeeze Market Structure", "Neutral", "Daily squeeze is active; " + bullish + " of " + available.length + " selected timeframes have bullish EMA structure. Lower-timeframe 1 ATR alignment is bonus only.");
  if (bearish) return layer("Squeeze Market Structure", "Bearish", "At least one selected timeframe has bearish EMA structure.");
  return layer("Squeeze Market Structure", "Conflicting", "Daily squeeze is active, but EMA alignment is mixed across selected timeframes.");
}

function evaluateInstitutional(input: {
  price: number;
  beta?: number;
  marketCap?: number;
  avgDollarVolume20d: number;
  optionable: boolean;
  strictFundamentals: boolean;
}): LayerEvaluation {
  const priceOk = input.price > defaultSettings.minPrice;
  const betaOk = input.beta === undefined ? !input.strictFundamentals : input.beta >= defaultSettings.minBeta;
  const marketCapOk = input.marketCap === undefined ? !input.strictFundamentals : input.marketCap >= defaultSettings.minMarketCap;
  const volumeOk = input.avgDollarVolume20d >= defaultSettings.minAvgDollarVolume;
  const passed = [priceOk, betaOk, marketCapOk, volumeOk, input.optionable].filter(Boolean).length;
  const detail = "Price $" + input.price.toFixed(2)
    + ", beta " + (input.beta?.toFixed(2) ?? "unavailable")
    + ", market cap " + (input.marketCap ? formatMoney(input.marketCap) : "unavailable")
    + ", avg dollar volume " + formatMoney(input.avgDollarVolume20d) + ".";
  if (passed === 5) return layer("Institutional Context", "Bullish", detail);
  if (passed >= 4) return layer("Institutional Context", "Neutral", detail);
  return layer("Institutional Context", "Bearish", detail);
}

function evaluateOptions(options: OptionContract[]): LayerEvaluation {
  if (!options.length) return layer("Options Market Context", "Bearish", "No liquid call contract met the selection filters.");
  const best = options[0];
  if (best.openInterest >= 250 && best.spreadPct <= 20 && best.delta !== undefined && best.delta >= 0.4 && best.delta <= 0.7) {
    return layer("Options Market Context", "Bullish", "Best call has healthy liquidity, delta, and spread.");
  }
  return layer("Options Market Context", "Neutral", "Usable call liquidity exists, but contract quality is not ideal.");
}

function evaluateCompression(contexts: LowerTimeframeContext[], dailyContext: LowerTimeframeContext, dailySqueezeDotCount: number): LayerEvaluation {
  const intradayActive = contexts.filter((context) => context.timeframe !== "daily" && isSqueezeActive(context.squeezeState)).length;
  if (dailySqueezeDotCount < 5) {
    return layer("Compression Quality", "Bearish", "At least 5 consecutive active daily squeeze dots are required; current count is " + dailySqueezeDotCount + ". Intraday squeezes are bonus only.");
  }
  return layer("Compression Quality", "Bullish", "Daily chart has " + dailySqueezeDotCount + " consecutive active squeeze dots. Lower-timeframe squeeze bonus count is " + intradayActive + ".");
}

function evaluateMacro(spyCandles?: Candle[], qqqCandles?: Candle[]): LayerEvaluation {
  if (!spyCandles?.length || !qqqCandles?.length) return layer("Macro Regime", "Neutral", "SPY/QQQ macro context was not available; market regime treated as contextual.");
  try {
    const spy = buildTimeframeContext("daily", spyCandles);
    const qqq = buildTimeframeContext("daily", qqqCandles);
    if (spy.bias === "bullish" && qqq.bias === "bullish") return layer("Macro Regime", "Bullish", "SPY and QQQ daily EMA structures are bullish.");
    if (spy.bias === "bearish" || qqq.bias === "bearish") return layer("Macro Regime", "Bearish", "SPY or QQQ daily EMA structure is bearish.");
    return layer("Macro Regime", "Neutral", "SPY/QQQ daily EMA structures are mixed.");
  } catch {
    return layer("Macro Regime", "Neutral", "SPY/QQQ macro context could not be calculated.");
  }
}

function evaluateRelativeStrength(candles: Candle[], spyCandles?: Candle[], qqqCandles?: Candle[]): string {
  if (!spyCandles?.length || !qqqCandles?.length) return "SPY/QQQ relative strength comparison unavailable; setup is evaluated from symbol trend and compression only.";
  const symbolReturn = percentReturn(candles.slice(-20));
  const spyReturn = percentReturn(spyCandles.slice(-20));
  const qqqReturn = percentReturn(qqqCandles.slice(-20));
  const spyText = symbolReturn >= spyReturn ? "outperforming SPY" : "underperforming SPY";
  const qqqText = symbolReturn >= qqqReturn ? "outperforming QQQ" : "underperforming QQQ";
  return "20-period relative strength: " + spyText + " and " + qqqText + ".";
}

function finalDecision(layerEvaluations: LayerEvaluation[], contexts: LowerTimeframeContext[], dailyContext: LowerTimeframeContext, weeklyStatus: LayerStatus): LongCallDecision {
  const byLayer = (name: LayerEvaluation["layer"]) => layerEvaluations.find((item) => item.layer === name)?.status;
  const lowerContexts = contexts.filter((context) => context.timeframe !== "daily");
  const bullishLowerTimeframes = lowerContexts.filter((context) => context.bias === "bullish").length;
  const bearishLowerTimeframe = lowerContexts.some((context) => context.bias === "bearish");
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  const dailyEntryAligned = dailyContext.withinOneAtrOfEma21;
  const bearishLayer = layerEvaluations.some((item) => item.status === "Bearish");
  if (bearishLayer || !dailySqueezeActive || !dailyEntryAligned || dailyContext.bias !== "bullish" || bearishLowerTimeframe) return "Avoid";
  if (
    byLayer("Compression Quality") === "Bullish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && bullishLowerTimeframes >= 2
    && weeklyStatus !== "Bearish"
  ) return "Strong Long Call Candidate";
  if (
    bullishLowerTimeframes >= 1
    && byLayer("Compression Quality") !== "Bearish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && weeklyStatus !== "Bearish"
  ) return "Moderate Long Call Candidate";
  return "Watchlist Candidate";
}

export function rankCallOptions(options: OptionContract[], price: number): OptionContract[] {
  return options
    .filter((contract) => contract.optionType === "call")
    .filter((contract) => contract.bid > 0 && contract.ask > 0)
    .filter((contract) => contract.openInterest >= 50 || contract.volume >= 25)
    .filter((contract) => contract.spreadPct <= 35)
    .filter((contract) => contract.delta === undefined || (contract.delta >= 0.4 && contract.delta <= 0.7))
    .filter((contract) => contract.dte === undefined || (contract.dte >= 30 && contract.dte <= 180))
    .filter((contract) => contract.strike <= price * 1.12)
    .sort((a, b) => optionQuality(b) - optionQuality(a));
}

function optionQuality(contract: OptionContract): number {
  const dte = contract.dte ?? 60;
  const dteScore = dte >= 30 && dte <= 90 ? 25 : dte >= 91 && dte <= 180 ? 18 : 0;
  const deltaScore = contract.delta === undefined ? 10 : Math.max(0, 25 - Math.abs(contract.delta - 0.55) * 100);
  const spreadScore = Math.max(0, 25 - contract.spreadPct);
  const liquidityScore = Math.min(25, contract.openInterest / 40 + contract.volume / 25);
  const ivPenalty = contract.impliedVolatility !== undefined && contract.impliedVolatility > 1.25 ? 15 : 0;
  return dteScore + deltaScore + spreadScore + liquidityScore - ivPenalty;
}

function contextFromIndicators(timeframe: "weekly", indicators: IndicatorSnapshot, price: number): LowerTimeframeContext {
  const positiveEmaStack = hasPositiveEmaStack(indicators);
  const priceAboveEmaStack = price > indicators.ema8 && price > indicators.ema21 && price > indicators.ema34 && price > indicators.ema55 && price > indicators.ema89;
  const atrDistanceFromEma21 = indicators.atr14 > 0 ? (price - indicators.ema21) / indicators.atr14 : Number.POSITIVE_INFINITY;
  const withinOneAtrOfEma21 = price >= indicators.ema21 && atrDistanceFromEma21 <= 1;
  const compressionScore = compressionQualityScore(indicators, priceAboveEmaStack);
  return {
    timeframe,
    bias: positiveEmaStack && priceAboveEmaStack ? "bullish" : !positiveEmaStack && !priceAboveEmaStack ? "bearish" : "neutral",
    price,
    ema8: indicators.ema8,
    ema21: indicators.ema21,
    ema34: indicators.ema34,
    ema55: indicators.ema55,
    ema89: indicators.ema89,
    positiveEmaStack,
    priceAboveEmaStack,
    atr14: indicators.atr14,
    atrDistanceFromEma21: round(atrDistanceFromEma21),
    withinOneAtrOfEma21,
    compressionScore,
    compressionStatus: compressionLayerStatus(compressionScore, indicators.squeezeState),
    squeezeState: indicators.squeezeState,
    detail: "Weekly context is " + (positiveEmaStack && priceAboveEmaStack ? "bullish" : "mixed") + " with squeeze " + indicators.squeezeState + "."
  };
}

function weeklySupportStatus(context: LowerTimeframeContext): LayerStatus {
  if (context.bias === "unavailable") return "Neutral";
  if (context.bias === "bullish") return isSqueezeActive(context.squeezeState) ? "Bullish" : "Neutral";
  if (context.bias === "bearish") return "Bearish";
  return "Neutral";
}

function unavailableLowerTimeframes(): LowerTimeframeConfluence {
  return {
    thirtyMinute: unavailableContext("30m", "No 30m candles were available."),
    oneHour: unavailableContext("1h", "No 1h candles were available."),
    fourHour: unavailableContext("4h", "No 4h candles were available.")
  };
}

function unavailableContext(timeframe: LowerTimeframeContext["timeframe"], detail: string): LowerTimeframeContext {
  return {
    timeframe,
    bias: "unavailable",
    price: null,
    ema8: null,
    ema21: null,
    ema34: null,
    ema55: null,
    ema89: null,
    positiveEmaStack: false,
    priceAboveEmaStack: false,
    atr14: null,
    atrDistanceFromEma21: null,
    withinOneAtrOfEma21: false,
    compressionScore: 0,
    compressionStatus: "Insufficient Data",
    squeezeState: "none",
    detail
  };
}

function withCurrentPrice(context: LowerTimeframeContext, price: number): LowerTimeframeContext {
  if (context.bias === "unavailable" || context.ema8 === null || context.ema21 === null || context.ema34 === null || context.ema55 === null || context.ema89 === null || context.atr14 === null) {
    return context;
  }
  const priceAboveEmaStack = price > context.ema8
    && price > context.ema21
    && price > context.ema34
    && price > context.ema55
    && price > context.ema89;
  const atrDistanceFromEma21 = context.atr14 > 0 ? (price - context.ema21) / context.atr14 : Number.POSITIVE_INFINITY;
  const withinOneAtrOfEma21 = price >= context.ema21 && atrDistanceFromEma21 <= 1;
  const bias = context.positiveEmaStack && priceAboveEmaStack ? "bullish" : !context.positiveEmaStack && !priceAboveEmaStack ? "bearish" : "neutral";
  return {
    ...context,
    bias,
    price,
    priceAboveEmaStack,
    atrDistanceFromEma21: round(atrDistanceFromEma21),
    withinOneAtrOfEma21,
    detail: context.timeframe + " is " + bias + ": current price $" + price.toFixed(2)
      + ", EMAs " + [context.ema8, context.ema21, context.ema34, context.ema55, context.ema89].join("/")
      + ", squeeze " + context.squeezeState
      + ", " + (withinOneAtrOfEma21 ? "inside" : "outside")
      + " the 1 ATR entry zone from the 21 EMA."
  };
}

function toTimeframeStatus(context: LowerTimeframeContext): TimeframeSqueezeStatus {
  return {
    timeframe: context.timeframe,
    squeezeState: context.squeezeState ?? "unavailable",
    bias: context.bias,
    priceAboveEmaStack: context.priceAboveEmaStack,
    positiveEmaStack: context.positiveEmaStack,
    withinOneAtrOfEma21: context.withinOneAtrOfEma21,
    compressionStatus: context.compressionStatus,
    detail: context.detail
  };
}

function entryType(decision: LongCallDecision, compressionStatus: LayerStatus) {
  if (decision === "Strong Long Call Candidate" && compressionStatus === "Bullish") return "High Conviction Compression Entry";
  if (decision === "Strong Long Call Candidate") return "Mid Compression Entry";
  if (decision === "Moderate Long Call Candidate") return "Early Compression Entry";
  if (decision === "Watchlist Candidate") return "Compression Watchlist";
  return "Avoid";
}

function weeklySummary(context: LowerTimeframeContext): string {
  if (context.bias === "unavailable") return "Weekly context unavailable; weekly squeeze is not required.";
  const squeezeBonus = isSqueezeActive(context.squeezeState) ? " Weekly squeeze adds bonus confirmation." : " Weekly squeeze is not required.";
  return "Weekly chart is " + context.bias + " with " + (context.positiveEmaStack ? "bullish" : "mixed") + " EMA structure." + squeezeBonus;
}

function alignmentSummary(contexts: LowerTimeframeContext[], weeklyContext: LowerTimeframeContext): string {
  const bullish = contexts.filter((context) => context.bias === "bullish").map((context) => context.timeframe).join(", ") || "none";
  const mixed = contexts.filter((context) => context.bias !== "bullish").map((context) => context.timeframe).join(", ") || "none";
  return "Bullish timeframes: " + bullish + ". Mixed/unavailable: " + mixed + ". Weekly: " + weeklyContext.bias + ".";
}

function supportReasons(layers: LayerEvaluation[], contexts: LowerTimeframeContext[], weeklyContext: LowerTimeframeContext, option?: OptionContract): string[] {
  const reasons = layers.filter((layerItem) => layerItem.status === "Bullish").map((layerItem) => layerItem.layer + ": " + layerItem.detail);
  const daily = contexts.find((context) => context.timeframe === "daily");
  const activeIntraday = contexts.filter((context) => context.timeframe !== "daily" && isSqueezeActive(context.squeezeState)).map((context) => context.timeframe);
  const lowerEntryAligned = contexts.filter((context) => context.timeframe !== "daily" && context.withinOneAtrOfEma21).map((context) => context.timeframe);
  if (daily && isSqueezeActive(daily.squeezeState)) reasons.push("Daily squeeze is active, which is required for swing qualification.");
  if (activeIntraday.length) reasons.push("Bonus intraday squeeze confirmation on " + activeIntraday.join(", ") + ".");
  if (lowerEntryAligned.length) reasons.push("Bonus lower-timeframe 1 ATR alignment on " + lowerEntryAligned.join(", ") + ".");
  if (isSqueezeActive(weeklyContext.squeezeState)) reasons.push("Weekly squeeze adds bonus confirmation.");
  if (option) reasons.push("Recommended call has OI " + option.openInterest + ", spread " + option.spreadPct.toFixed(1) + "%, delta " + (option.delta?.toFixed(2) ?? "unavailable") + ".");
  return reasons.slice(0, 6);
}

function riskReasons(layers: LayerEvaluation[], contexts: LowerTimeframeContext[], weeklyContext: LowerTimeframeContext, option?: OptionContract): string[] {
  const reasons = layers.filter((layerItem) => layerItem.status === "Bearish" || layerItem.status === "Conflicting").map((layerItem) => layerItem.layer + ": " + layerItem.detail);
  const daily = contexts.find((context) => context.timeframe === "daily");
  if (daily && !isSqueezeActive(daily.squeezeState)) reasons.push("Daily squeeze is not active; swing setup should be avoided.");
  const notBullish = contexts.filter((context) => context.bias !== "bullish").map((context) => context.timeframe);
  if (notBullish.length) reasons.push("Not fully aligned on " + notBullish.join(", ") + ".");
  const extended = contexts.filter((context) => context.timeframe === "daily" && context.bias !== "unavailable" && !context.withinOneAtrOfEma21).map((context) => context.timeframe);
  if (extended.length) reasons.push("Outside the 1 ATR entry zone from the 21 EMA on " + extended.join(", ") + ".");
  if (weeklyContext.bias === "bearish") reasons.push("Weekly bearish structure reduces setup quality.");
  if (!option) reasons.push("No preferred call contract was found.");
  return reasons.slice(0, 6);
}

function suggestedEntry(price: number, indicators: IndicatorSnapshot): string {
  const lower = indicators.ema21;
  const upper = indicators.ema21 + indicators.atr14;
  const prefix = price >= lower && price <= upper ? "Current price is inside the preferred entry zone: " : "Preferred entry zone: ";
  return prefix + "$" + round(lower, 2).toFixed(2) + " to $" + round(upper, 2).toFixed(2) + " (21 EMA to 21 EMA + 1 ATR).";
}

function invalidation(_price: number, indicators: IndicatorSnapshot): string {
  return "Daily close below 34/55 EMA zone near $" + round(Math.min(indicators.ema34, indicators.ema55), 2).toFixed(2) + ".";
}

function optionDteLabel(contract: OptionContract): string {
  if (contract.dte === undefined) return "30-180 DTE swing";
  return contract.dte + " DTE swing";
}

function alertMessage(symbol: string, decision: LongCallDecision, price: number, dailySqueezeDotCount: number): string {
  return symbol + " " + decision + " at $" + price.toFixed(2) + "; " + dailySqueezeDotCount + " active Daily squeeze dots. Watch for controlled consolidation before expansion.";
}

function journalRecord(symbol: string, decision: LongCallDecision, price: number, contexts: LowerTimeframeContext[], weeklyContext: LowerTimeframeContext, option?: OptionContract): string {
  return [
    symbol,
    decision,
    "price $" + price.toFixed(2),
    "aligned " + contexts.filter((context) => context.bias === "bullish").length + "/5 selected timeframes",
    "weekly " + weeklyContext.bias,
    option ? "contract " + option.description : "no preferred contract"
  ].join(" | ");
}

function layerToRule(item: LayerEvaluation): ScoreRule {
  return {
    id: item.layer.toLowerCase().replaceAll(" ", "-"),
    label: item.layer + ": " + item.status,
    points: 0,
    maxPoints: 0,
    passed: item.status === "Bullish" || item.status === "Neutral",
    detail: item.detail
  };
}

function layer(itemLayer: LayerEvaluation["layer"], status: LayerStatus, detail: string): LayerEvaluation {
  return { layer: itemLayer, status, detail };
}

function percentReturn(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  return first ? (last - first) / first : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}
