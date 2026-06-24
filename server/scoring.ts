import type {
  AssetType,
  Candle,
  Fundamentals,
  Grade,
  IndicatorSnapshot,
  InstitutionalFactor,
  InstitutionalFactorName,
  InstitutionalEdgeSummary,
  LayerEvaluation,
  LayerStatus,
  LongCallDecision,
  LowerTimeframeConfluence,
  LowerTimeframeContext,
  OptionContract,
  ScanResult,
  ScoreRule,
  SqueezeState,
  TimeframeSqueezeStatus,
  WeeklyQualificationMode
} from "../shared/types";
import { activeSqueezeDotCount, latestIndicators, round } from "./indicators";
import { buildTimeframeContext, compressionLayerStatus, compressionQualityScore, hasPositiveEmaStack } from "./timeframes";

const SQUEEZE_STATES: SqueezeState[] = ["low", "mid", "high"];
const SETUP_FACTOR_NAMES: InstitutionalFactorName[] = ["Market Regime", "Sector Strength", "Relative Strength", "Liquidity", "Price Structure", "Volatility Fit", "Catalyst Safety"];
const SETUP_FACTOR_WEIGHT = 100 / SETUP_FACTOR_NAMES.length;
export const A_SETUP_SCORE_THRESHOLD = 90;
export const B_SETUP_SCORE_THRESHOLD = 80;
export const WEEKLY_ATR_GRADE_CAP_REASON = "Weekly chart qualifies by 21 EMA proximity but does not have the full bullish EMA stack.";
const EARNINGS_AVOID_DAYS = 14;
const EARNINGS_NEUTRAL_DAYS = 29;

export const defaultSettings = {
  minPrice: 20,
  minBeta: 0.75,
  minMarketCap: 2_000_000_000,
  minAvgShareVolume: 600_000,
  minAvgDollarVolume: 300_000_000,
  useDemoDataWhenMissingApi: true
};

export function gradeSetup(input: {
  symbol: string;
  companyName?: string;
  assetType?: AssetType;
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
  minMarketCap?: number;
  minAvgShareVolume?: number;
  minAvgDollarVolume?: number;
}): ScanResult {
  const indicators = latestIndicators(input.candles);
  const assetType = input.assetType ?? "stock";
  const dailySqueezeDotCount = activeSqueezeDotCount(input.candles);
  const latest = input.candles[input.candles.length - 1];
  const price = input.currentPrice ?? latest.close;
  const beta = input.fundamentals?.beta;
  const marketCap = input.fundamentals?.marketCap;
  const sector = input.sector ?? input.fundamentals?.sector;
  const avgShareVolume = input.fundamentals?.avgShareVolume ?? average(input.candles.slice(-20).map((candle) => candle.volume));
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
    avgShareVolume,
    avgDollarVolume20d,
    optionable: input.optionable,
    strictFundamentals: Boolean(input.strictFundamentals),
    assetType,
    minMarketCap: input.minMarketCap ?? defaultSettings.minMarketCap,
    minAvgShareVolume: input.minAvgShareVolume ?? defaultSettings.minAvgShareVolume,
    minAvgDollarVolume: input.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume
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
    avgShareVolume,
    avgDollarVolume20d,
    minAvgShareVolume: input.minAvgShareVolume ?? defaultSettings.minAvgShareVolume,
    minAvgDollarVolume: input.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume,
    spyCandles: input.spyCandles,
    qqqCandles: input.qqqCandles,
    symbol: input.symbol,
    assetType,
    sector,
    sectorCandles: input.sectorCandles,
    nextEarningsDate: input.fundamentals?.nextEarningsDate
  });
  const weeklyQualificationMode = weeklyContext.weeklyQualificationMode ?? "none";
  const decision = finalDecision(layerEvaluations, dailyContext, weeklyQualificationMode, weeklySupport, setupScore);
  const scoreGrade = gradeFromSetupScore(setupScore.score);
  const grade = weeklyQualificationMode === "ema21-atr" && scoreGrade === "A" ? "B" : scoreGrade;
  const gradeCapReasons = decision === "Strong Long Call Candidate"
    ? []
    : gradeCapReasonsFor(layerEvaluations, weeklyContext, setupScore);
  const compressionQualityScoreValue = dailySqueezeDotCount;
  const warnings = input.lowerTimeframeWarnings ?? [];
  if (input.weeklySqueezeWarning) warnings.push(input.weeklySqueezeWarning);

  return {
    symbol: input.symbol,
    companyName: input.companyName,
    assetType,
    setupDirection: "long",
    dataSource: "demo",
    price,
    beta: beta ?? null,
    marketCap: marketCap ?? null,
    avgShareVolume: round(avgShareVolume, 0),
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
    weeklyQualificationMode,
    weeklyContextSummary: weeklySummary(weeklyContext),
    dailySqueezeDotCount,
    compressionQualityScore: compressionQualityScoreValue,
    compressionQualityStatus: compression.status,
    setupScore: setupScore.score,
    setupScoreStatus: setupScore.status,
    institutionalFactors: setupScore.factors,
    gradeCapReasons,
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
    stockStopPrice: round(Math.min(indicators.ema50, indicators.ema100), 2),
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

export function applyInstitutionalEdge(result: ScanResult, edge: InstitutionalEdgeSummary): ScanResult {
  const adjustment = Math.max(-10, Math.min(5, edge.adjustment));
  const setupScore = Math.max(0, Math.min(100, round(result.setupScore + adjustment, 0)));
  const scoreGrade = gradeFromSetupScore(setupScore);
  const weeklyQualificationMode = result.weeklyQualificationMode ?? "full-stack";
  const gradeCapReasons = (result.gradeCapReasons ?? []).filter((reason) => reason !== "Setup score below 90.");
  let longCallDecision: LongCallDecision = result.longCallDecision;
  let effectiveGrade = weeklyQualificationMode === "ema21-atr" && scoreGrade === "A" ? "B" : scoreGrade;

  if (result.longCallDecision !== "Avoid") {
    if (setupScore >= A_SETUP_SCORE_THRESHOLD && edge.status !== "Bearish" && weeklyQualificationMode === "full-stack") {
      longCallDecision = "Strong Long Call Candidate";
    } else if (setupScore >= B_SETUP_SCORE_THRESHOLD) {
      longCallDecision = "Moderate Long Call Candidate";
    } else {
      longCallDecision = "Watchlist Candidate";
    }
  }

  if (edge.status === "Bearish" && effectiveGrade === "A") {
    effectiveGrade = "B";
    if (longCallDecision === "Strong Long Call Candidate") longCallDecision = "Moderate Long Call Candidate";
    if (!gradeCapReasons.includes("Institutional Edge is bearish.")) gradeCapReasons.push("Institutional Edge is bearish.");
  }
  if (weeklyQualificationMode === "ema21-atr" && !gradeCapReasons.includes(WEEKLY_ATR_GRADE_CAP_REASON)) {
    gradeCapReasons.push(WEEKLY_ATR_GRADE_CAP_REASON);
  }
  if (setupScore < A_SETUP_SCORE_THRESHOLD && !gradeCapReasons.includes("Setup score below 90.")) {
    gradeCapReasons.push("Setup score below 90.");
  }

  return {
    ...result,
    setupScore,
    setupScoreStatus: setupScoreStatus(setupScore),
    grade: effectiveGrade,
    longCallDecision,
    setupQuality: effectiveGrade === "A" ? "High" : "Moderate",
    entryRecommendationType: entryType(longCallDecision, result.compressionQualityStatus),
    institutionalEdgeScore: edge.score,
    institutionalEdgeStatus: edge.status,
    institutionalEdgeFactors: edge.factors,
    institutionalEdgeAdjustment: adjustment,
    institutionalEdgeWarnings: edge.warnings,
    gradeCapReasons
  };
}

function evaluateMarketStructure(dailyContext: LowerTimeframeContext, weeklyContext: LowerTimeframeContext): LayerEvaluation {
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  if (!dailySqueezeActive) return layer("Squeeze Market Structure", "Bearish", "Daily squeeze is required for swing setups; daily squeeze state is " + dailyContext.squeezeState + ".");
  if (dailyContext.bias !== "bullish") return layer("Squeeze Market Structure", "Bearish", "Daily EMA structure is " + dailyContext.bias + "; bullish Daily structure is required.");
  if (!dailyContext.withinEmaPocket) return layer("Squeeze Market Structure", "Bearish", "Daily price is outside the EMA pocket between 0.1% above the 21 EMA and 0.1% below the 8 EMA.");
  if (weeklyContext.weeklyQualificationMode === "none") return layer("Squeeze Market Structure", "Bearish", "Weekly chart has neither the full bullish EMA stack nor price within one ATR above the 21 EMA.");
  if (weeklyContext.weeklyQualificationMode === "full-stack") return layer("Squeeze Market Structure", "Bullish", "Daily setup is bullish and the Weekly chart has the full bullish EMA stack.");
  return layer("Squeeze Market Structure", "Neutral", "Daily setup is bullish; Weekly price is above and within one ATR of the 21 EMA, but the full bullish EMA stack is not present.");
}

function evaluateInstitutional(input: {
  price: number;
  beta?: number;
  marketCap?: number;
  avgShareVolume: number;
  avgDollarVolume20d: number;
  optionable: boolean;
  strictFundamentals: boolean;
  assetType: AssetType;
  minMarketCap: number;
  minAvgShareVolume: number;
  minAvgDollarVolume: number;
}): LayerEvaluation {
  const priceOk = input.price > defaultSettings.minPrice;
  const betaOk = input.assetType === "etf" || (input.beta === undefined ? !input.strictFundamentals : input.beta >= defaultSettings.minBeta);
  const marketCapOk = input.assetType === "etf" || (input.marketCap === undefined ? !input.strictFundamentals : input.marketCap >= input.minMarketCap);
  const volumeOk = input.assetType === "etf"
    ? input.avgDollarVolume20d >= input.minAvgDollarVolume
    : stockLiquidityPasses(input.avgShareVolume, input.avgDollarVolume20d, input.minAvgShareVolume, input.minAvgDollarVolume);
  const passed = [priceOk, betaOk, marketCapOk, volumeOk, input.optionable].filter(Boolean).length;
  const detail = input.assetType === "etf"
    ? "ETF price $" + input.price.toFixed(2) + ", avg dollar volume " + formatMoney(input.avgDollarVolume20d) + "; beta and market cap are not required."
    : "Price $" + input.price.toFixed(2)
      + ", beta " + (input.beta?.toFixed(2) ?? "unavailable")
      + ", market cap " + (input.marketCap ? formatMoney(input.marketCap) : "unavailable")
      + ", avg share volume " + formatShares(input.avgShareVolume)
      + ", avg dollar volume " + formatMoney(input.avgDollarVolume20d) + ".";
  if (passed === 5) return layer("Institutional Context", "Bullish", detail);
  return layer("Institutional Context", "Bearish", detail);
}

function evaluateOptions(options: OptionContract[]): LayerEvaluation {
  if (!options.length) return layer("Options Market Context", "Bearish", "No call contract met the 20% maximum spread filter.");
  const best = options[0];
  if (best.spreadPct <= 10) return layer("Options Market Context", "Bullish", "Best call spread is " + best.spreadPct.toFixed(1) + "%, inside the 10% institutional-quality threshold.");
  return layer("Options Market Context", "Neutral", "Best call spread is " + best.spreadPct.toFixed(1) + "%; usable but wider than the 10% institutional-quality threshold.");
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

function finalDecision(layerEvaluations: LayerEvaluation[], dailyContext: LowerTimeframeContext, weeklyQualificationMode: WeeklyQualificationMode, weeklyStatus: LayerStatus, setupScore: SetupScoreResult): LongCallDecision {
  const byLayer = (name: LayerEvaluation["layer"]) => layerEvaluations.find((item) => item.layer === name)?.status;
  const dailySqueezeActive = isSqueezeActive(dailyContext.squeezeState);
  const dailyEntryAligned = dailyContext.withinEmaPocket;
  const bearishLayer = layerEvaluations.some((item) => item.status === "Bearish");
  if (bearishLayer || setupScore.catalystBlock || !dailySqueezeActive || !dailyEntryAligned || dailyContext.bias !== "bullish" || weeklyQualificationMode === "none" || weeklyStatus === "Bearish") return "Avoid";
  if (
    byLayer("Compression Quality") === "Bullish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && byLayer("Macro Regime") !== "Bearish"
    && setupScore.score >= A_SETUP_SCORE_THRESHOLD
    && weeklyQualificationMode === "full-stack"
  ) return "Strong Long Call Candidate";
  if (
    byLayer("Compression Quality") !== "Bearish"
    && byLayer("Options Market Context") !== "Bearish"
    && byLayer("Institutional Context") !== "Bearish"
    && byLayer("Macro Regime") !== "Bearish"
    && setupScore.score >= B_SETUP_SCORE_THRESHOLD
  ) return "Moderate Long Call Candidate";
  return "Watchlist Candidate";
}

function gradeFromSetupScore(score: number): Grade {
  if (score >= A_SETUP_SCORE_THRESHOLD) return "A";
  if (score >= B_SETUP_SCORE_THRESHOLD) return "B";
  return "C";
}

function setupScoreStatus(score: number): LayerStatus {
  if (score >= A_SETUP_SCORE_THRESHOLD) return "Bullish";
  if (score >= B_SETUP_SCORE_THRESHOLD) return "Neutral";
  return "Bearish";
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
  avgShareVolume: number;
  avgDollarVolume20d: number;
  minAvgShareVolume: number;
  minAvgDollarVolume: number;
  spyCandles?: Candle[];
  qqqCandles?: Candle[];
  symbol: string;
  assetType: AssetType;
  sector?: string;
  sectorCandles?: Candle[];
  nextEarningsDate?: string;
}): SetupScoreResult {
  const factors = [
    factor("Market Regime", input.marketRegime.status, input.marketRegime.detail),
    input.assetType === "etf" ? evaluateEtfStrength(input.symbol, input.candles, input.spyCandles) : evaluateSectorStrength(input.sector, input.sectorCandles, input.spyCandles),
    evaluateRelativeStrengthFactor(input.candles, input.spyCandles, input.qqqCandles),
    evaluateLiquidityFactor(input.avgShareVolume, input.avgDollarVolume20d, input.assetType, input.optionLayer, input.options[0], input.minAvgShareVolume, input.minAvgDollarVolume),
    evaluatePriceStructure(input.dailyContext),
    evaluateVolatilityFit(input.indicators, input.dailySqueezeDotCount),
    input.assetType === "etf" ? evaluateEtfCatalystSafety() : evaluateCatalystSafety(input.nextEarningsDate)
  ];
  const scored = factors.map((item) => ({ ...item, contribution: factorContribution(item.status) }));
  const score = round(scored.reduce((sum, item) => sum + item.contribution, 0), 0);
  const catalyst = scored.find((item) => item.name === "Catalyst Safety");
  const capA = scored.some((item) => (item.name === "Sector Strength" || item.name === "Catalyst Safety") && item.status === "Insufficient Data");
  const catalystBlock = catalyst?.status === "Bearish";
  return {
    score,
    status: score >= A_SETUP_SCORE_THRESHOLD ? "Bullish" : score >= B_SETUP_SCORE_THRESHOLD ? "Neutral" : "Bearish",
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

function evaluateEtfStrength(symbol: string, candles: Candle[], spyCandles?: Candle[]): InstitutionalFactor {
  if (!spyCandles?.length) return factor("Sector Strength", "Insufficient Data", "SPY comparison unavailable for ETF relative strength.");
  const etfReturn = percentReturn(candles.slice(-20));
  const spyReturn = percentReturn(spyCandles.slice(-20));
  const spread = etfReturn - spyReturn;
  if (spread >= 0) return factor("Sector Strength", "Bullish", symbol + " ETF outperforming SPY over 20 periods.");
  if (spread >= -0.01) return factor("Sector Strength", "Neutral", symbol + " ETF is roughly in line with SPY.");
  return factor("Sector Strength", "Bearish", symbol + " ETF underperforming SPY over 20 periods.");
}

function gradeCapReasonsFor(layerEvaluations: LayerEvaluation[], weeklyContext: LowerTimeframeContext, setupScore: SetupScoreResult): string[] {
  const reasons: string[] = [];
  const layer = (name: LayerEvaluation["layer"]) => layerEvaluations.find((item) => item.layer === name);
  const factor = (name: InstitutionalFactorName) => setupScore.factors.find((item) => item.name === name);
  if (setupScore.score < A_SETUP_SCORE_THRESHOLD) reasons.push("Setup score below 90.");
  if (weeklyContext.weeklyQualificationMode === "ema21-atr") reasons.push(WEEKLY_ATR_GRADE_CAP_REASON);
  if (weeklyContext.weeklyQualificationMode === "none") reasons.push("Weekly context does not qualify.");
  if (factor("Sector Strength")?.status === "Insufficient Data") reasons.push("Sector Strength unavailable.");
  if (factor("Catalyst Safety")?.status === "Insufficient Data") reasons.push("Catalyst Safety unavailable.");
  if (layer("Options Market Context")?.status === "Neutral") reasons.push("Options Market Context is neutral.");
  return reasons;
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

function evaluateLiquidityFactor(avgShareVolume: number, avgDollarVolume20d: number, assetType: AssetType, optionLayer: LayerEvaluation, option: OptionContract | undefined, minAvgShareVolume: number, minAvgDollarVolume: number): InstitutionalFactor {
  const stockLiquid = assetType === "etf"
    ? avgDollarVolume20d >= minAvgDollarVolume
    : stockLiquidityPasses(avgShareVolume, avgDollarVolume20d, minAvgShareVolume, minAvgDollarVolume);
  if (!stockLiquid || optionLayer.status === "Bearish") return factor("Liquidity", "Bearish", "Stock or option liquidity failed preferred filters.");
  if (optionLayer.status === "Bullish") return factor("Liquidity", "Bullish", assetType === "etf"
    ? "High dollar volume and strong option liquidity."
    : "Average share or dollar volume passes and option liquidity is strong.");
  return factor("Liquidity", "Neutral", "Stock liquidity passes; option chain is usable but not ideal" + (option ? "." : " or unavailable."));
}

export function stockLiquidityPasses(avgShareVolume: number | undefined, avgDollarVolume: number | undefined, minAvgShareVolume = defaultSettings.minAvgShareVolume, minAvgDollarVolume = defaultSettings.minAvgDollarVolume): boolean {
  return (avgShareVolume ?? 0) >= minAvgShareVolume || (avgDollarVolume ?? 0) >= minAvgDollarVolume;
}

function evaluatePriceStructure(context: LowerTimeframeContext): InstitutionalFactor {
  if (context.bias === "bullish" && context.withinEmaPocket) return factor("Price Structure", "Bullish", "Daily structure bullish and inside the EMA pocket.");
  if (context.bias === "bullish") return factor("Price Structure", "Neutral", "Daily structure bullish but entry is outside the EMA pocket.");
  return factor("Price Structure", "Bearish", "Daily EMA structure is not bullish.");
}

function evaluateVolatilityFit(indicators: IndicatorSnapshot, dailySqueezeDotCount: number): InstitutionalFactor {
  if (dailySqueezeDotCount < 5) return factor("Volatility Fit", "Bearish", "Daily squeeze dot count is below 5.");
  const supportive = [indicators.atrContracting, indicators.bbContracting, indicators.candleRangeContracting, indicators.momentumImproving].filter(Boolean).length;
  if (supportive >= 3) return factor("Volatility Fit", "Bullish", "Daily squeeze active with contraction and improving momentum.");
  if (supportive >= 1) return factor("Volatility Fit", "Neutral", "Daily squeeze active; contraction/momentum support is mixed.");
  return factor("Volatility Fit", "Bearish", "Daily squeeze active but contraction/momentum support is weak.");
}

function evaluateCatalystSafety(nextEarningsDate?: string): InstitutionalFactor {
  if (!nextEarningsDate) return factor("Catalyst Safety", "Insufficient Data", "Next earnings date unavailable; A grade capped.");
  const days = daysUntil(nextEarningsDate);
  if (days === undefined || days < 0) return factor("Catalyst Safety", "Insufficient Data", "Next earnings date unavailable; A grade capped.");
  if (days <= EARNINGS_AVOID_DAYS) return factor("Catalyst Safety", "Bearish", "Earnings are within " + EARNINGS_AVOID_DAYS + " days.");
  if (days <= EARNINGS_NEUTRAL_DAYS) return factor("Catalyst Safety", "Neutral", "Earnings are 15-29 days away; catalyst risk is elevated.");
  return factor("Catalyst Safety", "Bullish", "Next earnings is at least 30 days away.");
}

function evaluateEtfCatalystSafety(): InstitutionalFactor {
  return factor("Catalyst Safety", "Bullish", "ETF has no single-company earnings date; catalyst risk is not applicable.");
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
    .filter((contract) => contract.spreadPct <= 20)
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
  const atrDistanceFromEma21 = indicators.atr14 > 0 ? (price - indicators.ema21) / indicators.atr14 : Number.POSITIVE_INFINITY;
  const percentAboveEma21 = indicators.ema21 > 0 ? ((price - indicators.ema21) / indicators.ema21) * 100 : Number.POSITIVE_INFINITY;
  const percentAboveEma50 = indicators.ema50 > 0 ? ((price - indicators.ema50) / indicators.ema50) * 100 : Number.POSITIVE_INFINITY;
  const percentBelowEma8 = indicators.ema8 > 0 ? ((indicators.ema8 - price) / indicators.ema8) * 100 : Number.NEGATIVE_INFINITY;
  const emaPocketLower = indicators.ema21 * 1.001;
  const emaPocketUpper = indicators.ema8 * 0.999;
  const withinEmaPocket = price >= emaPocketLower && price <= emaPocketUpper;
  const priceAboveEmaStack = price > indicators.ema50 && price > indicators.ema100;
  const weeklyQualificationMode = resolveWeeklyQualificationMode(indicators, price);
  const compressionScore = compressionQualityScore(indicators, priceAboveEmaStack);
  return {
    timeframe,
    bias: positiveEmaStack && priceAboveEmaStack ? "bullish" : !positiveEmaStack && !priceAboveEmaStack ? "bearish" : "neutral",
    price,
    ema8: indicators.ema8,
    ema21: indicators.ema21,
    ema34: indicators.ema34,
    ema50: indicators.ema50,
    ema55: indicators.ema55,
    ema89: indicators.ema89,
    ema100: indicators.ema100,
    positiveEmaStack,
    priceAboveEmaStack,
    atr14: indicators.atr14,
    atrDistanceFromEma21: round(atrDistanceFromEma21),
    withinOneAtrOfEma21: withinEmaPocket,
    percentAboveEma21: round(percentAboveEma21),
    withinTwoPercentOfEma21: withinEmaPocket,
    percentAboveEma50: round(percentAboveEma50),
    percentBelowEma8: round(percentBelowEma8),
    withinEmaPocket,
    weeklyQualificationMode,
    compressionScore,
    compressionStatus: compressionLayerStatus(compressionScore, indicators.squeezeState),
    squeezeState: indicators.squeezeState,
    detail: weeklyQualificationDetail(weeklyQualificationMode, atrDistanceFromEma21, indicators.squeezeState)
  };
}

function weeklySupportStatus(context: LowerTimeframeContext): LayerStatus {
  if (context.bias === "unavailable") return "Bearish";
  if (context.weeklyQualificationMode === "full-stack") return isSqueezeActive(context.squeezeState) ? "Bullish" : "Neutral";
  if (context.weeklyQualificationMode === "ema21-atr") return "Neutral";
  return "Bearish";
}

function unavailableContext(timeframe: LowerTimeframeContext["timeframe"], detail: string): LowerTimeframeContext {
  return {
    timeframe,
    bias: "unavailable",
    price: null,
    ema8: null,
    ema21: null,
    ema34: null,
    ema50: null,
    ema55: null,
    ema89: null,
    ema100: null,
    positiveEmaStack: false,
    priceAboveEmaStack: false,
    atr14: null,
    atrDistanceFromEma21: null,
    withinOneAtrOfEma21: false,
    percentAboveEma21: null,
    withinTwoPercentOfEma21: false,
    percentAboveEma50: null,
    percentBelowEma8: null,
    withinEmaPocket: false,
    weeklyQualificationMode: timeframe === "weekly" ? "none" : undefined,
    compressionScore: 0,
    compressionStatus: "Insufficient Data",
    squeezeState: "none",
    detail
  };
}

function withCurrentPrice(context: LowerTimeframeContext, price: number): LowerTimeframeContext {
  if (context.bias === "unavailable" || context.ema8 === null || context.ema21 === null || context.ema50 === null || context.ema100 === null || context.atr14 === null) {
    return context;
  }
  const atrDistanceFromEma21 = context.atr14 > 0 ? (price - context.ema21) / context.atr14 : Number.POSITIVE_INFINITY;
  const percentAboveEma21 = context.ema21 > 0 ? ((price - context.ema21) / context.ema21) * 100 : Number.POSITIVE_INFINITY;
  const percentAboveEma50 = context.ema50 > 0 ? ((price - context.ema50) / context.ema50) * 100 : Number.POSITIVE_INFINITY;
  const percentBelowEma8 = context.ema8 > 0 ? ((context.ema8 - price) / context.ema8) * 100 : Number.NEGATIVE_INFINITY;
  const emaPocketLower = context.ema21 * 1.001;
  const emaPocketUpper = context.ema8 * 0.999;
  const withinEmaPocket = price >= emaPocketLower && price <= emaPocketUpper;
  const priceAboveEmaStack = price > context.ema50 && price > context.ema100;
  const bias = context.positiveEmaStack && priceAboveEmaStack ? "bullish" : !context.positiveEmaStack && !priceAboveEmaStack ? "bearish" : "neutral";
  return {
    ...context,
    bias,
    price,
    priceAboveEmaStack,
    atrDistanceFromEma21: round(atrDistanceFromEma21),
    withinOneAtrOfEma21: withinEmaPocket,
    percentAboveEma21: round(percentAboveEma21),
    withinTwoPercentOfEma21: withinEmaPocket,
    percentAboveEma50: round(percentAboveEma50),
    percentBelowEma8: round(percentBelowEma8),
    withinEmaPocket,
    detail: context.timeframe + " is " + bias + ": current price $" + price.toFixed(2)
      + ", EMAs " + [context.ema8, context.ema21, context.ema50, context.ema100].join("/")
      + ", squeeze " + context.squeezeState
      + ", " + (withinEmaPocket ? "inside" : "outside")
      + " the EMA pocket between 0.1% above the 21 EMA and 0.1% below the 8 EMA."
  };
}

function toTimeframeStatus(context: LowerTimeframeContext): TimeframeSqueezeStatus {
  return {
    timeframe: context.timeframe,
    squeezeState: context.squeezeState ?? "unavailable",
    bias: context.bias,
    priceAboveEmaStack: context.priceAboveEmaStack,
    positiveEmaStack: context.positiveEmaStack,
    withinOneAtrOfEma21: context.withinEmaPocket,
    percentAboveEma21: context.percentAboveEma21,
    withinTwoPercentOfEma21: context.withinEmaPocket,
    percentAboveEma50: context.percentAboveEma50,
    percentBelowEma8: context.percentBelowEma8,
    withinEmaPocket: context.withinEmaPocket,
    weeklyQualificationMode: context.weeklyQualificationMode,
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
  if (context.bias === "unavailable") return "Weekly context unavailable; the setup does not qualify.";
  const squeezeBonus = isSqueezeActive(context.squeezeState) ? " Weekly squeeze adds bonus confirmation." : " Weekly squeeze is not required.";
  if (context.weeklyQualificationMode === "full-stack") return "Weekly chart qualifies with the full bullish 8/21/50/100 EMA stack." + squeezeBonus;
  if (context.weeklyQualificationMode === "ema21-atr") return "Weekly chart qualifies because price is above and within one ATR of the 21 EMA; grade is capped at B without the full bullish EMA stack." + squeezeBonus;
  return "Weekly chart does not qualify because it lacks the full bullish EMA stack and is not within one ATR above the 21 EMA.";
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
  if (dailyContext.bias !== "unavailable" && !dailyContext.withinEmaPocket) reasons.push("Outside the EMA pocket between 0.1% above the 21 EMA and 0.1% below the 8 EMA on daily.");
  if (weeklyContext.weeklyQualificationMode === "none") reasons.push("Weekly chart lacks both qualifying structures.");
  if (!option) reasons.push("No preferred call contract was found.");
  return reasons.slice(0, 6);
}

function suggestedEntry(price: number, indicators: IndicatorSnapshot): string {
  const lower = indicators.ema21 * 1.001;
  const upper = indicators.ema8 * 0.999;
  const prefix = price >= lower && price <= upper ? "Current price is inside the preferred entry zone: " : "Preferred entry zone: ";
  return prefix + "$" + round(lower, 2).toFixed(2) + " to $" + round(upper, 2).toFixed(2) + " (0.1% above 21 EMA to 0.1% below 8 EMA).";
}

function invalidation(_price: number, indicators: IndicatorSnapshot): string {
  return "Daily close below 50/100 EMA zone near $" + round(Math.min(indicators.ema50, indicators.ema100), 2).toFixed(2) + ".";
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

function formatShares(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M shares";
  if (value >= 1_000) return Math.round(value / 1_000) + "K shares";
  return Math.round(value) + " shares";
}

export function resolveWeeklyQualificationMode(indicators: IndicatorSnapshot, price: number): WeeklyQualificationMode {
  const fullStack = hasPositiveEmaStack(indicators) && price > indicators.ema50 && price > indicators.ema100;
  if (fullStack) return "full-stack";
  if (indicators.atr14 <= 0 || price < indicators.ema21) return "none";
  return (price - indicators.ema21) / indicators.atr14 <= 1 ? "ema21-atr" : "none";
}

function weeklyQualificationDetail(mode: WeeklyQualificationMode, atrDistance: number, squeezeState: SqueezeState): string {
  if (mode === "full-stack") return "Weekly chart qualifies with the full bullish EMA stack; squeeze " + squeezeState + ".";
  if (mode === "ema21-atr") return "Weekly chart qualifies with price " + round(atrDistance) + " ATR above the 21 EMA; full bullish EMA stack is not present.";
  return "Weekly chart does not qualify; price/EMA structure is outside both approved weekly paths.";
}
