export type Grade = "A" | "B" | "C";
export type TradeDirection = "long" | "short";
export type AssetType = "stock" | "etf";
export type WeeklyQualificationMode = "full-stack" | "ema21-atr" | "none";
export type DailyEntryQualificationMode = "strict" | "broad" | "extended" | "none";
export type SqueezeMaturityMode = "mature" | "developing" | "insufficient";
export type ScanMode = "live" | "demo" | "mixed";
export type ScanStatus = "idle" | "running" | "complete" | "failed";
export type AnalysisTimeframe = "30m" | "1h" | "4h" | "daily" | "weekly";

export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Fundamentals = {
  symbol: string;
  beta?: number;
  marketCap?: number;
  avgShareVolume?: number;
  avgDollarVolume20d?: number;
  lastEarningsDate?: string;
  nextEarningsDate?: string;
  sector?: string;
  sources?: FundamentalFieldSources;
};

export type FundamentalDataSource = "schwab" | "fmp" | "history" | "demo";
export type FundamentalFieldSources = {
  beta?: FundamentalDataSource;
  marketCap?: FundamentalDataSource;
  avgShareVolume?: FundamentalDataSource;
  avgDollarVolume20d?: FundamentalDataSource;
  lastEarningsDate?: FundamentalDataSource;
  nextEarningsDate?: FundamentalDataSource;
  sector?: FundamentalDataSource;
};


export type OptionContract = {
  symbol: string;
  description: string;
  expirationDate: string;
  strike: number;
  optionType: "call" | "put";
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  delta?: number;
  impliedVolatility?: number;
  dte?: number;
  spreadPct: number;
  score: number;
};

export type SqueezeState = "none" | "low" | "mid" | "high" | "released";
export type SqueezeMomentumColor = "cyan" | "blue" | "red" | "yellow";
export type TimeframeBias = "bullish" | "bearish" | "neutral" | "unavailable";
export type LayerStatus = "Bullish" | "Neutral" | "Bearish" | "Conflicting" | "Insufficient Data";
export type LongCallDecision = "Strong Long Call Candidate" | "Moderate Long Call Candidate" | "Watchlist Candidate" | "Avoid";
export type EntryRecommendationType = "Early Compression Entry" | "Mid Compression Entry" | "High Conviction Compression Entry" | "Compression Watchlist" | "Avoid";
export type TradeMark = "Take" | "Avoid";
export type InstitutionalFactorName = "Daily Structure" | "Daily Squeeze Momentum" | "Compression Quality" | "Relative Strength" | "Sector Strength" | "Catalyst Safety";
export type InstitutionalEdgeFactorName =
  | "Financial Quality"
  | "Analyst Conviction"
  | "Insider Safety"
  | "ETF Quality"
  | "ETF Exposure";

export type InstitutionalFactor = {
  name: InstitutionalFactorName;
  status: LayerStatus;
  contribution: number;
  detail: string;
};

export type InstitutionalEdgeFactor = {
  name: InstitutionalEdgeFactorName;
  status: LayerStatus;
  adjustment: number;
  detail: string;
};

export type InstitutionalEdgeSummary = {
  status: LayerStatus;
  score: number;
  adjustment: number;
  factors: InstitutionalEdgeFactor[];
  warnings: string[];
};

export type OptionsFlowSignal = "bullish" | "mixed" | "bearish" | "neutral";
export type OptionsExposureSignal = "supportive" | "neutral" | "hostile" | "squeeze_prone";
export type DarkPoolSignal = "accumulation" | "neutral" | "distribution" | "no_data";
export type InstitutionalPositioningStatus = "confirmed" | "neutral" | "capped" | "vetoed";

export type InstitutionalPositioningSummary = {
  score: number;
  optionsFlowSignal: OptionsFlowSignal;
  optionsExposureSignal: OptionsExposureSignal;
  darkPoolSignal: DarkPoolSignal;
  status: InstitutionalPositioningStatus;
  reason: string;
  flags: string[];
  warnings: string[];
};

export type LowerTimeframeContext = {
  timeframe: AnalysisTimeframe;
  bias: TimeframeBias;
  price: number | null;
  ema8: number | null;
  ema21: number | null;
  ema34: number | null;
  ema50: number | null;
  ema55: number | null;
  ema89: number | null;
  ema100: number | null;
  positiveEmaStack: boolean;
  priceAboveEmaStack: boolean;
  atr14: number | null;
  atrDistanceFromEma21: number | null;
  withinOneAtrOfEma21: boolean;
  percentAboveEma21: number | null;
  withinTwoPercentOfEma21: boolean;
  percentAboveEma50: number | null;
  percentBelowEma8: number | null;
  withinEmaPocket: boolean;
  dailyEntryQualificationMode?: DailyEntryQualificationMode;
  weeklyQualificationMode?: WeeklyQualificationMode;
  compressionScore: number;
  compressionStatus: LayerStatus;
  squeezeState?: SqueezeState;
  detail: string;
};

export type LowerTimeframeConfluence = {
  thirtyMinute: LowerTimeframeContext;
  oneHour: LowerTimeframeContext;
  fourHour: LowerTimeframeContext;
};

export type IndicatorSnapshot = {
  ema8: number;
  ema21: number;
  ema34: number;
  ema50: number;
  ema55: number;
  ema89: number;
  ema100: number;
  atr14: number;
  atrContracting: boolean;
  bbUpper: number;
  bbLower: number;
  bbWidth: number;
  bbContracting: boolean;
  kcLowUpper: number;
  kcLowLower: number;
  kcMidUpper: number;
  kcMidLower: number;
  kcHighUpper: number;
  kcHighLower: number;
  momentum: number;
  momentumImproving: boolean;
  momentumColor?: SqueezeMomentumColor;
  candleRangeContracting: boolean;
  squeezeState: SqueezeState;
};

export type ScoreRule = {
  id: string;
  label: string;
  points: number;
  maxPoints: number;
  passed: boolean;
  detail: string;
};

export type LayerEvaluation = {
  layer: "Squeeze Market Structure" | "Institutional Context" | "Options Market Context" | "Macro Regime" | "Compression Quality";
  status: LayerStatus;
  detail: string;
};

export type TimeframeSqueezeStatus = {
  timeframe: AnalysisTimeframe;
  squeezeState: SqueezeState | "unavailable";
  bias: TimeframeBias;
  priceAboveEmaStack: boolean;
  positiveEmaStack: boolean;
  withinOneAtrOfEma21: boolean;
  percentAboveEma21?: number | null;
  withinTwoPercentOfEma21?: boolean;
  percentAboveEma50?: number | null;
  percentBelowEma8?: number | null;
  withinEmaPocket?: boolean;
  dailyEntryQualificationMode?: DailyEntryQualificationMode;
  weeklyQualificationMode?: WeeklyQualificationMode;
  compressionStatus: LayerStatus;
  detail: string;
};

export type ScanResult = {
  symbol: string;
  companyName?: string;
  assetType: AssetType;
  setupDirection: TradeDirection;
  dataSource: "schwab" | "demo" | "mixed";
  price: number;
  beta: number | null;
  marketCap: number | null;
  currentVolume?: number;
  avgShareVolume?: number;
  avgDollarVolume20d: number;
  fundamentalSources?: FundamentalFieldSources;
  nextEarningsDate?: string;
  daysUntilNextEarnings?: number;
  optionable: boolean;
  passesUniverse: boolean;
  grade: Grade;
  tradeMark?: TradeMark;
  tradeMarkReasons?: string[];
  longCallDecision: LongCallDecision;
  setupQuality: "High" | "Moderate";
  entryRecommendationType: EntryRecommendationType;
  score: number;
  maxScore: number;
  indicators: IndicatorSnapshot;
  weeklyIndicators?: IndicatorSnapshot;
  lowerTimeframes?: LowerTimeframeConfluence;
  squeezeStatusByTimeframe: TimeframeSqueezeStatus[];
  dailyEntryQualificationMode?: DailyEntryQualificationMode;
  weeklyQualificationMode?: WeeklyQualificationMode;
  weeklyContextSummary: string;
  dailySqueezeDotCount?: number;
  squeezeMaturityMode?: SqueezeMaturityMode;
  compressionQualityScore: number;
  compressionQualityStatus: LayerStatus;
  setupScore: number;
  setupScoreStatus: LayerStatus;
  institutionalFactors: InstitutionalFactor[];
  institutionalEdgeScore?: number;
  institutionalEdgeStatus?: LayerStatus;
  institutionalEdgeFactors?: InstitutionalEdgeFactor[];
  institutionalEdgeAdjustment?: number;
  institutionalEdgeWarnings?: string[];
  institutionalPositioningScore?: number;
  optionsFlowSignal?: OptionsFlowSignal;
  optionsExposureSignal?: OptionsExposureSignal;
  darkPoolSignal?: DarkPoolSignal;
  institutionalPositioningStatus?: InstitutionalPositioningStatus;
  institutionalPositioningReason?: string;
  strongLongCallCandidate?: boolean;
  flags?: string[];
  gradeCapReasons?: string[];
  multiTimeframeAlignmentSummary: string;
  relativeStrengthSummary: string;
  institutionalContextSummary: string;
  macroRegimeSummary: string;
  layerEvaluations: LayerEvaluation[];
  recommendedOptionContract?: OptionContract;
  recommendedDte?: string;
  recommendedDelta?: string;
  suggestedEntryArea: string;
  invalidationLevel: string;
  stockStopPrice: number | null;
  target1: number | null;
  target2: number | null;
  reasonsSupportingTrade: string[];
  reasonsAgainstTrade: string[];
  alertMessage: string;
  journalRecord: string;
  rules: ScoreRule[];
  suggestedOptions: OptionContract[];
  candles: Candle[];
  lastUpdated: string;
  warnings: string[];
};

export type Settings = {
  minPrice: number;
  minBeta: number;
  minMarketCap: number;
  minCurrentVolume: number;
  minAvgShareVolume: number;
  minAvgDollarVolume: number;
  brokerBaseUrl: string;
  brokerCallbackUrl: string;
  hasBrokerCredentials: boolean;
  useDemoDataWhenMissingApi: boolean;
  etfSymbols: string[];
  defaultUniverseName: string;
  defaultUniverseCount: number;
  defaultUniverseLastCheckedAt?: string;
};

export type BrokerStatus = {
  configured: boolean;
  baseUrl: string;
  ok: boolean;
  checkedAt: string;
  sampleSymbol?: string;
  samplePrice?: number;
  needsLogin?: boolean;
  loginUrl?: string;
  message: string;
};

export type FundamentalAnalysis = {
  symbol: string;
  companyName?: string;
  price: number | null;
  volume: number | null;
  averageVolume: number | null;
  avgDollarVolume: number | null;
  marketCap: number | null;
  beta: number | null;
  sector?: string;
  eps: number | null;
  peRatio: number | null;
  dividendAmount: number | null;
  dividendYield: number | null;
  dividendFrequency?: string;
  dividendPayAmount: number | null;
  dividendPayDate?: string;
  dividendExDate?: string;
  lastEarningsDate?: string;
  nextEarningsDate?: string;
  sourceStatus: "live" | "fallback" | "mixed" | "unavailable";
  fieldSources?: FundamentalFieldSources;
  sourceNotes?: string[];
  dividendStatus: "pays" | "does_not_pay" | "unknown";
  warnings: string[];
  scanContext?: {
    grade: Grade;
    direction: TradeDirection;
    score: number;
    maxScore: number;
    longCallDecision?: LongCallDecision;
    dailySqueeze: SqueezeState;
    weeklySqueeze?: SqueezeState;
    thirtyMinuteSqueeze?: SqueezeState;
    oneHourSqueeze?: SqueezeState;
    fourHourSqueeze?: SqueezeState;
    optionable: boolean;
    suggestedOptionCount: number;
  };
};

export type ScanMetadata = {
  scanStatus: ScanStatus;
  lastScanStartedAt?: string;
  lastScanFinishedAt?: string;
  lastScanMode?: ScanMode;
  lastScanWarnings?: string[];
  scanDiagnostics?: ScanDiagnostics;
  nextRefreshAt?: string;
  isRefreshing?: boolean;
};

export type ScanDiagnosticCounts = {
  quoteMissing: number;
  price: number;
  stockLiquidity: number;
  marketCap: number;
  candleHistory: number;
  options: number;
  spreadLiquidity: number;
  marketStructure: number;
  catalyst: number;
  sectorDataCap: number;
  finalDisplayFilter: number;
  other: number;
};

export type ScanDiagnostics = {
  scannedSymbols: number;
  qualifiedResults: number;
  minAvgShareVolume: number;
  minAvgDollarVolume: number;
  skipped: ScanDiagnosticCounts;
};

export type ScanResponse = ScanMetadata & {
  mode: ScanMode;
  results: ScanResult[];
  settings: Settings;
  warnings: string[];
};
