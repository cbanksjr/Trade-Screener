export type Grade = "A" | "B";
export type TradeDirection = "long" | "short";
export type ScanMode = "live" | "demo" | "mixed";
export type ScanStatus = "idle" | "running" | "complete" | "failed";
export type ChartTimeframe = "30m" | "1h" | "4h" | "1d" | "1w";
export type AnalysisTimeframe = "30m" | "1h" | "4h" | "daily" | "weekly";

export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ChartDataResponse = {
  symbol: string;
  timeframe: ChartTimeframe;
  candles: Candle[];
  warnings: string[];
};

export type Fundamentals = {
  symbol: string;
  beta?: number;
  marketCap?: number;
  avgDollarVolume20d?: number;
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
export type TimeframeBias = "bullish" | "bearish" | "neutral" | "unavailable";
export type LayerStatus = "Bullish" | "Neutral" | "Bearish" | "Conflicting" | "Insufficient Data";
export type LongCallDecision = "Strong Long Call Candidate" | "Moderate Long Call Candidate" | "Watchlist Candidate" | "Avoid";
export type EntryRecommendationType = "Early Compression Entry" | "Mid Compression Entry" | "High Conviction Compression Entry" | "Compression Watchlist" | "Avoid";

export type LowerTimeframeContext = {
  timeframe: AnalysisTimeframe;
  bias: TimeframeBias;
  price: number | null;
  ema8: number | null;
  ema21: number | null;
  ema34: number | null;
  ema55: number | null;
  ema89: number | null;
  positiveEmaStack: boolean;
  priceAboveEmaStack: boolean;
  atr14: number | null;
  atrDistanceFromEma21: number | null;
  withinOneAtrOfEma21: boolean;
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
  ema55: number;
  ema89: number;
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
  compressionStatus: LayerStatus;
  detail: string;
};

export type ScanResult = {
  symbol: string;
  companyName?: string;
  setupDirection: TradeDirection;
  dataSource: "schwab" | "demo" | "mixed";
  price: number;
  beta: number | null;
  marketCap: number | null;
  avgDollarVolume20d: number;
  optionable: boolean;
  passesUniverse: boolean;
  grade: Grade;
  longCallDecision: LongCallDecision;
  setupQuality: "High" | "Moderate";
  entryRecommendationType: EntryRecommendationType;
  score: number;
  maxScore: number;
  indicators: IndicatorSnapshot;
  weeklyIndicators?: IndicatorSnapshot;
  lowerTimeframes?: LowerTimeframeConfluence;
  squeezeStatusByTimeframe: TimeframeSqueezeStatus[];
  weeklyContextSummary: string;
  dailySqueezeDotCount?: number;
  compressionQualityScore: number;
  compressionQualityStatus: LayerStatus;
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
  minAvgDollarVolume: number;
  brokerBaseUrl: string;
  brokerCallbackUrl: string;
  hasBrokerCredentials: boolean;
  useDemoDataWhenMissingApi: boolean;
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
  eps: number | null;
  peRatio: number | null;
  dividendAmount: number | null;
  dividendYield: number | null;
  dividendFrequency?: string;
  dividendPayAmount: number | null;
  dividendPayDate?: string;
  dividendExDate?: string;
  lastEarningsDate?: string;
  sourceStatus: "live" | "unavailable";
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
  nextRefreshAt?: string;
  isRefreshing?: boolean;
};

export type ScanResponse = ScanMetadata & {
  mode: ScanMode;
  results: ScanResult[];
  settings: Settings;
  warnings: string[];
};
