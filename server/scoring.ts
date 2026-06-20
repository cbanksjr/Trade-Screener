import type {
  Candle,
  Fundamentals,
  Grade,
  IndicatorSnapshot,
  InstitutionalFactor,
  InstitutionalFactorName,
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
const SETUP_FACTOR_NAMES: InstitutionalFactorName[] = ["Market Regime", "Sector Strength", "Relative Strength", "Liquidity", "Volume Expansion", "Price Structure", "Volatility Fit", "Catalyst Safety"];
const SETUP_FACTOR_WEIGHT = 100 / SETUP_FACTOR_NAMES.length;
const EARNINGS_DANGER_DAYS = 10;

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
  sector?: string;
  sectorCandles?: Candle[];
  strictFundamentals?: boolean;
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const dailySqueezeDotCount = activeSqueezeDotCount(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = input.currentPrice ?? latest.close;
  const beta = input.fundamentals?.beta;
  const marketCap = input.fundamentals?.marketCap;
  const sector = input.sector ?? input.fundamentals?.sector;
  const avgDollarVolume20d = input.fundamentals?.avgDollarVolume20d ?? average(input.candles.slice(-20).map((candle) => candle.volume * candle.close));
  const dailyContext = withCurrentPrice(buildTimeframeContext("daily", input.candles), price);
  const weeklyContext = input.weeklyIndicators ? contextFromIndicators("weekly", input.weeklyIndicators, price) : unavailableContext("weekly", "Weekly context could not be calculated.");
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
  const marketStructure = evaluateMarketStructure(dailyContext, weeklyContext);
  const optionLayer = evaluateOptions(options);
  const compression = evaluateCompression(dailySqueezeDotCount);
  const macro = evaluateMacro(input.spyCandles, input.qqqCandles);
  const relativeStrengthSummary = evaluateRelativeStrength(input.candles, input.spyCandles, input.qqqCandles);
  const layerEvaluations = [marketStructure, institutional, optionLayer, macro, compression];
  const setupScore = evaluateSetupScore({
    candles: input.candles,
    dailyContext,
    indicators,
    dailySqueezeDotCount,
    marketRegime: macro,
    institutional,
    optionLayer,
    options,
    avgDollarVolume20d,
    spyCandles: input.spyCandles,
    qqqCandles: input.qqqCandles,
    sector,
    sectorCandles: input.sectorCandles,
    lastEarningsDate: input.fundamentals?.lastEarningsDate
  });
  const decision = finalDecision(layerEvaluations, dailyContext, weeklyContext, weeklySupport, setupScore);
  const grade = decision === "Strong Long Call Candidate" ? "A" : "B";
  const compressionQualityScoreValue = dailySqueezeDotCount;
  const warnings = input.lowerTimeframeWarnings ?? [];
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
    fundamentalSources: input.fundamentals?.sources,
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
    lowerTimeframes: input.lowerTimeframes,
    squeezeStatusByTimeframe: [
      toTimeframeStatus(dailyContext),
      toTimeframeStatus(weeklyContext)
    ],
    weeklyContextSummary: weeklySummary(weeklyContext),
    dailySqueezeDotCount,
    compressionQualityScore: compressionQualityScoreValue,
    compressionQualityStatus: compression.status,
    setupScore: setupScore.score,
    setupScoreStatus: setupScore.status,
    institutionalFactors: setupScore.factors,
    multiTimeframeAlignmentSummary: alignmentSummary(dailyContext, weeklyContext),
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
    reasonsSupportingTrade: supportReasons(layerEvaluations, dailyContext, weeklyContext, recommendedOption),
    reasonsAgainstTrade: riskReasons(layerEvaluations, dailyContext, weeklyContext, recommendedOption),
    alertMessage: alertMessage(input.symbol, decision, price, dailySqueezeDotCount),
    journalRecord: journalRecord(input.symbol, decision, price, dailyContext, weeklyContext, recommendedOption),
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

function evaluateMarketStructure(dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext): LayerEvaluation {
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  if (!dailySqueezeActive) return layer("Squeeze Market Structure", "Bearish", "Daily squeeze is required for swing setups; daily squeeze state is " + dailyContext.squeezeState + ".");
  if (dailyContext.bias !== "bullish") return layer("Squeeze Market Structure", "Bearish", "Daily EMA structure is " + dailyContext.bias + "; bullish Daily structure is required.");
  if (!dailyContext.withinOneAtrOfEma21) return layer("Squeeze Market Structure", "Bearish", "Daily price is outside the 1 ATR entry zone from the 21 EMA.");
  if (weeklyContext.bias === "bearish") return layer("Squeeze Market Structure", "Bearish", "Weekly bearish structure blocks swing candidates.");
  if (weeklyContext.bias === "bullish") return layer("Squeeze Market Structure", "Bullish", "Daily setup is bullish and Weekly structure supports the swing thesis.");
  return layer("Squeeze Market Structure", "Neutral", "Daily setup is bullish; Weekly context is " + weeklyContext.bias + ".");
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

function evaluateCompression(dailySqueezeDotCount: number): LayerEvaluation {
  if (dailySqueezeDotCount < 5) {
    return layer("Compression Quality", "Bearish", "At least 5 consecutive active daily squeeze dots are required; current count is " + dailySqueezeDotCount + ".");
  }
  return layer("Compression Quality", "Bullish", "Daily chart has " + dailySqueezeDotCount + " consecutive active squeeze dots.");
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

function finalDecision(layerEvaluations: LayerEvaluation[], dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext, weeklyStatus: LayerStatus, setupScore: SetupScoreResult): LongCallDecision {
  const byLayer = (name: LayerEvaluation["layer"]) => layerEvaluations.find((item) => item.layer === name)?.status;
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  const dailyEntryAligned = dailyContext.withinOneAtrOfEma21;
  const bearishLayer = layerEvaluations.some((item) => item.status === "Bearish");
  if (bearishLayer || setupScore.catalystBlock || !dailySqueezeActive || !dailyEntryAligned || dailyContext.bias !== "bullish" || weeklyStatus === "Bearish") return "Avoid";
  if (
    byLayer("Compression Quality") === "Bullish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && byLayer("Macro Regime") !== "Bearish"
    && weeklyContext.bias === "bullish"
    && !setupScore.capA
  ) return "Strong Long Call Candidate";
  if (
    byLayer("Compression Quality") !== "Bearish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && byLayer("Macro Regime") !== "Bearish"
  ) return "Moderate Long Call Candidate";
  return "Watchlist Candidate";
}

type SetupScoreResult = {
  score: number;
  status: LayerStatus;
  factors: InstitutionalFactor[];
  capA: boolean;
  catalystBlock: boolean;
};

function evaluateSetupScore(input: {
  candles: Candle[];
  dailyContext: LowerTimeframeContext;
  indicators: IndicatorSnapshot;
  dailySqueezeDotCount: number;
  marketRegime: LayerEvaluation;
  institutional: LayerEvaluation;
  optionLayer: LayerEvaluation;
  options: OptionContract[];
  avgDollarVolume20d: number;
  spyCandles?: Candle[];
  qqqCandles?: Candle[];
  sector?: string;
  sectorCandles?: Candle[];
  lastEarningsDate?: string;
}): SetupScoreResult {
  const factors = [
    factor("Market Regime", input.marketRegime.status, input.marketRegime.detail),
    evaluateSectorStrength(input.sector, input.sectorCandles, input.spyCandles),
    evaluateRelativeStrengthFactor(input.candles, input.spyCandles, input.qqqCandles),
    evaluateLiquidityFactor(input.avgDollarVolume20d, input.optionLayer, input.options[0]),
    evaluateVolumeExpansion(input.candles),
    evaluatePriceStructure(input.dailyContext),
    evaluateVolatilityFit(input.indicators, input.dailySqueezeDotCount),
    evaluateCatalystSafety(input.lastEarningsDate)
  ];
  const scored = factors.map((item) => ({ ...item, contribution: factorContribution(item.status) }));
  const score = round(scored.reduce((sum, item) => sum + item.contribution, 0), 0);
  const catalyst = scored.find((item) => item.name === "Catalyst Safety");
  const capA = scored.some((item) => (item.name === "Sector Strength" || item.name === "Catalyst Safety") && item.status === "Insufficient Data");
  const catalystBlock = catalyst?.status === "Bearish";
  return {
    score,
    status: score >= 75 ? "Bullish" : score >= 50 ? "Neutral" : "Bearish",
    factors: scored,
    capA,
    catalystBlock
  };
}

function evaluateSectorStrength(sector?: string, sectorCandles?: Candle[], spyCandles?: Candle[]): InstitutionalFactor {
  if (!sector) return factor("Sector Strength", "Insufficient Data", "Sector unavailable; A grade capped.");
  if (!sectorCandles?.length || !spyCandles?.length) return factor("Sector Strength", "Insufficient Data", sector + " sector history unavailable; A grade capped.");
  const sectorReturn = percentReturn(sectorCandles.slice(-20));
  const spyReturn = percentReturn(spyCandles.slice(-20));
  const spread = sectorReturn - spyReturn;
  if (spread >= 0) return factor("Sector Strength", "Bullish", sector + " sector outperforming SPY over 20 periods.");
  if (spread >= -0.01) return factor("Sector Strength", "Neutral", sector + " sector is roughly in line with SPY.");
  return factor("Sector Strength", "Bearish", sector + " sector underperforming SPY over 20 periods.");
}

function evaluateRelativeStrengthFactor(candles: Candle[], spyCandles?: Candle[], qqqCandles?: Candle[]): InstitutionalFactor {
  if (!spyCandles?.length || !qqqCandles?.length) return factor("Relative Strength", "Insufficient Data", "SPY/QQQ comparison unavailable.");
  const symbolReturn = percentReturn(candles.slice(-20));
  const spyReturn = percentReturn(spyCandles.slice(-20));
  const qqqReturn = percentReturn(qqqCandles.slice(-20));
  const beats = [symbolReturn >= spyReturn, symbolReturn >= qqqReturn].filter(Boolean).length;
  if (beats === 2) return factor("Relative Strength", "Bullish", "Outperforming SPY and QQQ over 20 periods.");
  if (beats === 1) return factor("Relative Strength", "Neutral", "Outperforming one of SPY/QQQ over 20 periods.");
  return factor("Relative Strength", "Bearish", "Underperforming SPY and QQQ over 20 periods.");
}

function evaluateLiquidityFactor(avgDollarVolume20d: number, optionLayer: LayerEvaluation, option?: OptionContract): InstitutionalFactor {
  const stockLiquid = avgDollarVolume20d >= defaultSettings.minAvgDollarVolume;
  if (!stockLiquid || optionLayer.status === "Bearish") return factor("Liquidity", "Bearish", "Stock or option liquidity failed preferred filters.");
  if (optionLayer.status === "Bullish") return factor("Liquidity", "Bullish", "High dollar volume and strong option liquidity.");
  return factor("Liquidity", "Neutral", "Stock liquidity passes; option chain is usable but not ideal" + (option ? "." : " or unavailable."));
}

function evaluateVolumeExpansion(candles: Candle[]): InstitutionalFactor {
  if (candles.length < 45) return factor("Volume Expansion", "Insufficient Data", "Not enough volume history.");
  const latestVolume = candles.at(-1)?.volume ?? 0;
  const recent = average(candles.slice(-5).map((candle) => candle.volume));
  const baseline = average(candles.slice(-25, -5).map((candle) => candle.volume));
  if (baseline <= 0) return factor("Volume Expansion", "Insufficient Data", "Volume baseline unavailable.");
  if (latestVolume >= baseline * 1.25 && recent >= baseline * 1.1) return factor("Volume Expansion", "Bullish", "Volume expanding above recent baseline.");
  if (latestVolume >= baseline * 0.8 || recent >= baseline * 0.9) return factor("Volume Expansion", "Neutral", "Volume is steady but not clearly expanding.");
  return factor("Volume Expansion", "Bearish", "Volume is below recent baseline.");
}

function evaluatePriceStructure(context: LowerTimeframeContext): InstitutionalFactor {
  if (context.bias === "bullish" && context.withinOneAtrOfEma21) return factor("Price Structure", "Bullish", "Daily structure bullish and inside 1 ATR.");
  if (context.bias === "bullish") return factor("Price Structure", "Neutral", "Daily structure bullish but entry is extended from the 21 EMA.");
  return factor("Price Structure", "Bearish", "Daily EMA structure is not bullish.");
}

function evaluateVolatilityFit(indicators: IndicatorSnapshot, dailySqueezeDotCount: number): InstitutionalFactor {
  if (dailySqueezeDotCount < 5) return factor("Volatility Fit", "Bearish", "Daily squeeze dot count is below 5.");
  const supportive = [indicators.atrContracting, indicators.bbContracting, indicators.candleRangeContracting, indicators.momentumImproving].filter(Boolean).length;
  if (supportive >= 3) return factor("Volatility Fit", "Bullish", "Daily squeeze active with contraction and improving momentum.");
  if (supportive >= 1) return factor("Volatility Fit", "Neutral", "Daily squeeze active; contraction/momentum support is mixed.");
  return factor("Volatility Fit", "Bearish", "Daily squeeze active but contraction/momentum support is weak.");
}

function evaluateCatalystSafety(lastEarningsDate?: string): InstitutionalFactor {
  if (!lastEarningsDate) return factor("Catalyst Safety", "Insufficient Data", "Earnings date unavailable; A grade capped.");
  const days = daysUntil(lastEarningsDate);
  if (days === undefined || days < 0) return factor("Catalyst Safety", "Insufficient Data", "Future earnings date unavailable; A grade capped.");
  if (days <= EARNINGS_DANGER_DAYS) return factor("Catalyst Safety", "Bearish", "Earnings are within " + EARNINGS_DANGER_DAYS + " days.");
  return factor("Catalyst Safety", "Bullish", "No earnings event inside the next " + EARNINGS_DANGER_DAYS + " days.");
}

function factor(name: InstitutionalFactorName, status: LayerStatus, detail: string): InstitutionalFactor {
  return { name, status, contribution: 0, detail };
}

function factorContribution(status: LayerStatus): number {
  if (status === "Bullish") return SETUP_FACTOR_WEIGHT;
  if (status === "Neutral" || status === "Insufficient Data") return SETUP_FACTOR_WEIGHT / 2;
  return 0;
}

function daysUntil(value: string): number | undefined {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return Math.ceil((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
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

function alignmentSummary(dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext): string {
  return "Daily: " + dailyContext.bias + ". Weekly: " + weeklyContext.bias + ".";
}

function supportReasons(layers: LayerEvaluation[], dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext, option?: OptionContract): string[] {
  const reasons = layers.filter((layerItem) => layerItem.status === "Bullish").map((layerItem) => layerItem.layer + ": " + layerItem.detail);
  if (isSqueezeActive(dailyContext.squeezeState)) reasons.push("Daily squeeze is active, which is required for swing qualification.");
  if (isSqueezeActive(weeklyContext.squeezeState)) reasons.push("Weekly squeeze adds bonus confirmation.");
  if (option) reasons.push("Recommended call has OI " + option.openInterest + ", spread " + option.spreadPct.toFixed(1) + "%, delta " + (option.delta?.toFixed(2) ?? "unavailable") + ".");
  return reasons.slice(0, 6);
}

function riskReasons(layers: LayerEvaluation[], dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext, option?: OptionContract): string[] {
  const reasons = layers.filter((layerItem) => layerItem.status === "Bearish" || layerItem.status === "Conflicting").map((layerItem) => layerItem.layer + ": " + layerItem.detail);
  if (!isSqueezeActive(dailyContext.squeezeState)) reasons.push("Daily squeeze is not active; swing setup should be avoided.");
  if (dailyContext.bias !== "bullish") reasons.push("Daily EMA structure is not bullish.");
  if (dailyContext.bias !== "unavailable" && !dailyContext.withinOneAtrOfEma21) reasons.push("Outside the 1 ATR entry zone from the 21 EMA on daily.");
  if (weeklyContext.bias === "bearish") reasons.push("Weekly bearish structure blocks the setup.");
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

function journalRecord(symbol: string, decision: LongCallDecision, price: number, dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext, option?: OptionContract): string {
  return [
    symbol,
    decision,
    "price $" + price.toFixed(2),
    "daily " + dailyContext.bias,
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
