export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";
export type TradeDirection = "long" | "short";

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
  spreadPct: number;
  score: number;
};

export type SqueezeState = "none" | "low" | "mid" | "high" | "released";

export type IndicatorSnapshot = {
  ema21: number;
  ema50: number;
  atr14: number;
  bbUpper: number;
  bbLower: number;
  kcLowUpper: number;
  kcLowLower: number;
  kcMidUpper: number;
  kcMidLower: number;
  kcHighUpper: number;
  kcHighLower: number;
  momentum: number;
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
  score: number;
  maxScore: number;
  indicators: IndicatorSnapshot;
  rules: ScoreRule[];
  suggestedOptions: OptionContract[];
  candles: Candle[];
  lastUpdated: string;
  warnings: string[];
};

export type Settings = {
  scanMode: "universe" | "watchlist";
  symbols: string[];
  minPrice: number;
  minBeta: number;
  minMarketCap: number;
  minAvgDollarVolume: number;
  brokerBaseUrl: string;
  brokerCallbackUrl: string;
  hasBrokerCredentials: boolean;
  useDemoDataWhenMissingApi: boolean;
  importedUniverseCount: number;
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

export type ScanResponse = {
  mode: "live" | "demo" | "mixed";
  results: ScanResult[];
  settings: Settings;
  warnings: string[];
};
