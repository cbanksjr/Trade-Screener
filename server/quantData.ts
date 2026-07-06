import type {
  DarkPoolSignal,
  InstitutionalPositioningStatus,
  InstitutionalPositioningSummary,
  IvRankSignal,
  MaxPainSignal,
  OpenInterestChangeSignal,
  OptionsExposureSignal,
  OptionsFlowSignal
} from "../shared/types";
import { config } from "./config";
import { fetchWithRetry } from "./httpRetry";
import { getSetting, setSetting } from "./sqlite";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type EndpointId =
  | "net-drift"
  | "order-flow-consolidated"
  | "exposure-by-strike"
  | "dark-pool-levels"
  | "max-pain"
  | "open-interest-change"
  | "iv-rank"
  | "net-flow"
  | "gainers-losers";

type EndpointCacheEntry = {
  updatedAt: string;
  data: unknown;
};

export type QuantDataCache = {
  responses: Record<string, Partial<Record<string, EndpointCacheEntry>>>;
};

export type QuantDataEnrichContext = {
  compressionActive?: boolean;
  nearestExpirationDate?: string;
  daysToNearestExpiration?: number;
};

export type QuantDataPositioningResult = {
  positioning: InstitutionalPositioningSummary;
  warnings: string[];
  usedLive: boolean;
};

type OptionsFlowEvaluation = {
  signal: OptionsFlowSignal;
  score: number;
  detail: string;
  flags: string[];
  stronglyBearish: boolean;
};

type OptionsExposureEvaluation = {
  signal: OptionsExposureSignal;
  score: number;
  detail: string;
  flags: string[];
};

type DarkPoolEvaluation = {
  signal: DarkPoolSignal;
  score: number;
  detail: string;
  flags: string[];
};

type MaxPainEvaluation = {
  signal: MaxPainSignal;
  score: number;
  detail: string;
  flags: string[];
};

type OpenInterestChangeEvaluation = {
  signal: OpenInterestChangeSignal;
  score: number;
  detail: string;
  flags: string[];
};

type IvRankEvaluation = {
  signal: IvRankSignal;
  score: number;
  detail: string;
  flags: string[];
};

const CACHE_KEY = "quantDataCache";
const ENDPOINT_PATHS: Record<EndpointId, string> = {
  "net-drift": "/v1/options/tool/net-drift",
  "order-flow-consolidated": "/v1/options/tool/order-flow-consolidated",
  "exposure-by-strike": "/v1/options/tool/exposure-by-strike",
  "dark-pool-levels": "/v1/equities/tool/dark-pool-levels",
  "max-pain": "/v1/options/tool/max-pain",
  "open-interest-change": "/v1/options/tool/open-interest-change",
  "iv-rank": "/v1/options/tool/iv-rank",
  "net-flow": "/v1/options/tool/net-flow",
  "gainers-losers": "/v1/options/tool/gainers-losers"
};
const UNIVERSE_CACHE_SYMBOL = "__UNIVERSE__";
const MIN_DAYS_FOR_PIN_RISK = 3;
const MIN_OI_BUILD_CONTRACTS = 500;
const MIN_OI_BUILD_PERCENT = 5;
const DEFAULT_POSITIONING: InstitutionalPositioningSummary = {
  score: 50,
  optionsFlowSignal: "neutral",
  optionsExposureSignal: "neutral",
  darkPoolSignal: "no_data",
  maxPainSignal: "no_data",
  openInterestChangeSignal: "no_data",
  ivRankSignal: "no_data",
  status: "neutral",
  reason: "QuantData positioning was unavailable; grade unchanged.",
  flags: [],
  warnings: [],
  confirmingFactorCount: 0,
  vetoingFactorCount: 0
};

export async function createQuantDataPositioningScanProvider(): Promise<ReturnType<typeof createQuantDataPositioningProvider> | undefined> {
  if (!config.quantDataEnabled || !config.quantDataApiKey) return undefined;
  const cache = await getSetting<QuantDataCache>(CACHE_KEY, { responses: {} });
  const provider = createQuantDataPositioningProvider({
    apiKey: config.quantDataApiKey,
    baseUrl: config.quantDataBaseUrl,
    maxCalls: Math.max(0, config.quantDataMaxCallsPerScan),
    cacheTtlMs: Math.max(1, config.quantDataCacheTtlMinutes) * 60 * 1000,
    cache
  });
  return {
    ...provider,
    async flush() {
      if (provider.isDirty()) await setSetting(CACHE_KEY, provider.cache());
    }
  };
}

export function createQuantDataPositioningProvider(input: {
  apiKey: string;
  baseUrl: string;
  maxCalls: number;
  cacheTtlMs?: number;
  cache?: QuantDataCache;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  let remainingCalls = input.maxCalls;
  let dirty = false;
  const cache: QuantDataCache = { responses: { ...(input.cache?.responses ?? {}) } };
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const cacheTtlMs = input.cacheTtlMs ?? 15 * 60 * 1000;

  async function enrich(symbol: string, price: number, context: QuantDataEnrichContext = {}): Promise<QuantDataPositioningResult> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !input.apiKey) return { positioning: DEFAULT_POSITIONING, warnings: [], usedLive: false };
    const previousFlowSessionDate = previousTradingSessionDate(now());
    const previousFlowSessionRange = { startDate: previousFlowSessionDate, endDate: previousFlowSessionDate };
    const maxPainPromise = context.nearestExpirationDate
      ? loadEndpoint(upperSymbol, "max-pain", { filter: { ticker: upperSymbol }, expirationDate: context.nearestExpirationDate }, context.nearestExpirationDate)
      : Promise.resolve({ warnings: [], usedLive: false } as { data?: unknown; warnings: string[]; usedLive: boolean });

    const [netDrift, orderFlow, exposure, darkPool, maxPain, oiChange, ivRank] = await Promise.all([
      loadEndpoint(upperSymbol, "net-drift", { sessionDateRange: previousFlowSessionRange, filter: { ticker: upperSymbol } }),
      loadEndpoint(upperSymbol, "order-flow-consolidated", { sessionDateRange: previousFlowSessionRange, filter: { ticker: upperSymbol }, size: 100 }),
      loadEndpoint(upperSymbol, "exposure-by-strike", {
        filter: { ticker: upperSymbol },
        greekMode: "GAMMA",
        representationMode: "NOTIONAL"
      }),
      loadEndpoint(upperSymbol, "dark-pool-levels", {
        sessionDateRange: { startDate: isoDate(addDays(now(), -14)) },
        filter: { ticker: upperSymbol }
      }),
      maxPainPromise,
      loadEndpoint(upperSymbol, "open-interest-change", {
        sessionDateRange: previousFlowSessionRange,
        filter: { ticker: upperSymbol, contractType: "CALL" }
      }),
      loadEndpoint(upperSymbol, "iv-rank", { filter: { ticker: upperSymbol } })
    ]);

    const warnings = [
      ...netDrift.warnings, ...orderFlow.warnings, ...exposure.warnings, ...darkPool.warnings,
      ...maxPain.warnings, ...oiChange.warnings, ...ivRank.warnings
    ];
    const flowEvaluation = normalizeOptionsFlow(netDrift.data, orderFlow.data);
    const exposureEvaluation = normalizeOptionsExposure(exposure.data, price);
    const darkPoolEvaluation = normalizeDarkPool(darkPool.data, price);
    const maxPainEvaluation = normalizeMaxPain(maxPain.data, price, context.daysToNearestExpiration);
    const oiChangeEvaluation = normalizeOpenInterestChange(oiChange.data, price);
    const ivRankEvaluation = normalizeIvRank(ivRank.data, Boolean(context.compressionActive));
    // If an endpoint returned a live body we still couldn't parse, surface the
    // actual response keys so the mismatch is diagnosable instead of silent.
    if (maxPain.data !== undefined && maxPainEvaluation.signal === "no_data") warnings.push(`QuantData max-pain shape unrecognized: ${describeBodyKeys(maxPain.data)}`);
    if (ivRank.data !== undefined && ivRankEvaluation.signal === "no_data") warnings.push(`QuantData iv-rank shape unrecognized: ${describeBodyKeys(ivRank.data)}`);
    if (oiChange.data !== undefined && oiChangeEvaluation.signal === "no_data") warnings.push(`QuantData open-interest-change shape unrecognized: ${describeBodyKeys(oiChange.data)}`);
    if (exposure.data !== undefined && exposureEvaluation.detail === "Options exposure unavailable.") warnings.push(`QuantData exposure-by-strike shape unrecognized: ${describeBodyKeys(exposure.data)}`);
    const positioning = summarizePositioning(
      flowEvaluation, exposureEvaluation, darkPoolEvaluation, maxPainEvaluation, oiChangeEvaluation, ivRankEvaluation, warnings
    );
    return {
      positioning,
      warnings,
      usedLive: [netDrift, orderFlow, exposure, darkPool, maxPain, oiChange, ivRank].some((item) => item.usedLive)
    };
  }

  async function loadEndpoint(
    symbol: string,
    endpoint: EndpointId,
    body: Record<string, unknown>,
    cacheKeySuffix?: string
  ): Promise<{ data?: unknown; warnings: string[]; usedLive: boolean }> {
    const cacheKey = cacheKeySuffix ? `${endpoint}:${cacheKeySuffix}` : endpoint;
    const cached = cache.responses[symbol]?.[cacheKey];
    if (cached && isFresh(cached.updatedAt, cacheTtlMs, now())) return { data: cached.data, warnings: [], usedLive: false };
    if (remainingCalls <= 0) return { warnings: ["QuantData call budget exhausted."], usedLive: false };

    remainingCalls -= 1;
    const response = await fetchWithRetry(() => fetchImpl(quantDataUrl(input.baseUrl, ENDPOINT_PATHS[endpoint]), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }));
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { warnings: [`QuantData ${endpoint} was not authorized; skipped.`], usedLive: true };
    }
    if (response.status === 422) return { warnings: [`QuantData ${endpoint} rejected the request parameters (422); no data returned.`], usedLive: true };
    if (response.status === 429) return { warnings: [`QuantData ${endpoint} was rate limited; skipped.`], usedLive: true };
    if (!response.ok) return { warnings: [`QuantData ${endpoint} request failed: ${response.status} ${response.statusText}`], usedLive: true };

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { warnings: [`QuantData ${endpoint} returned malformed JSON; skipped.`], usedLive: true };
    }
    cache.responses[symbol] = {
      ...(cache.responses[symbol] ?? {}),
      [cacheKey]: { updatedAt: now().toISOString(), data }
    };
    dirty = true;
    return { data, warnings: [], usedLive: true };
  }

  async function rankSymbols(symbols: string[]): Promise<{ symbols: string[]; warnings: string[]; usedLive: boolean }> {
    if (!input.apiKey || !symbols.length) return { symbols, warnings: [], usedLive: false };
    const [netFlow, gainersLosers] = await Promise.all([
      loadEndpoint(UNIVERSE_CACHE_SYMBOL, "net-flow", {}, "universe"),
      loadEndpoint(UNIVERSE_CACHE_SYMBOL, "gainers-losers", {}, "universe")
    ]);
    const warnings = [...netFlow.warnings, ...gainersLosers.warnings];
    const ranking = normalizeFlowRanking(netFlow.data, gainersLosers.data);
    if (!ranking.size) return { symbols, warnings, usedLive: netFlow.usedLive || gainersLosers.usedLive };
    const ranked = [...symbols].sort((a, b) => (ranking.get(b) ?? 0) - (ranking.get(a) ?? 0));
    return { symbols: ranked, warnings, usedLive: netFlow.usedLive || gainersLosers.usedLive };
  }

  return {
    enrich,
    rankSymbols,
    cache: () => cache,
    remainingCalls: () => remainingCalls,
    isDirty: () => dirty,
    async flush() {
      // Overridden by createQuantDataPositioningScanProvider where persistent settings are available.
    }
  };
}

export function previousTradingSessionDate(from: Date): string {
  let cursor = addDays(marketDateUtc(from), -1);
  while (isWeekend(cursor) || isUsMarketHoliday(cursor)) {
    cursor = addDays(cursor, -1);
  }
  return isoDate(cursor);
}

export function normalizeOptionsFlow(netDriftPayload: unknown, orderFlowPayload?: unknown): OptionsFlowEvaluation {
  const driftBuckets = payloadRows(netDriftPayload);
  const orderRows = payloadRows(orderFlowPayload);
  const netCallPremium = sumNumbers(driftBuckets, ["netCallPremium", "callPremium", "callsPremium"]);
  const netPutPremium = Math.abs(sumNumbers(driftBuckets, ["netPutPremium", "putPremium", "putsPremium"]));
  const netCallVolume = sumNumbers(driftBuckets, ["netCallVolume", "callVolume", "callsVolume"]);
  const netPutVolume = Math.abs(sumNumbers(driftBuckets, ["netPutVolume", "putVolume", "putsVolume"]));
  let askSideCallPremium = 0;
  let callSweepCount = 0;
  let openingCallCount = 0;
  let bullishRowCount = 0;
  let bearishRowCount = 0;

  for (const row of orderRows) {
    const contractType = normalizedString(row.contractType, row.optionType, row.putCall, row.side);
    const premium = numberValue(row.premium, row.totalPremium, row.notionalValue, row.costBasis) ?? 0;
    const sentiment = normalizedString(row.sentiment, row.direction, row.tradeSide, row.aggressorSide);
    const isCall = contractType.includes("call");
    const isPut = contractType.includes("put");
    const askSide = sentiment.includes("ask") || sentiment.includes("buy") || sentiment.includes("bull");
    if (isCall && askSide) askSideCallPremium += Math.abs(premium);
    if (isCall && booleanish(row.isSweep, row.sweep, row.isSweepTrade)) callSweepCount += 1;
    if (isCall && normalizedString(row.openClose, row.opening, row.transactionType).includes("open")) openingCallCount += 1;
    if ((isCall && askSide) || sentiment.includes("bull")) bullishRowCount += 1;
    if ((isPut && askSide) || sentiment.includes("bear")) bearishRowCount += 1;
  }

  const callPremium = netCallPremium;
  const putPremium = netPutPremium;
  const totalPremium = callPremium + putPremium;
  const flags: string[] = [];
  if (callPremium >= Math.max(100_000, putPremium * 1.35)) flags.push("Bullish Flow Confirmation");
  if (askSideCallPremium >= 50_000) flags.push("Ask-Side Call Buying");
  if (netCallVolume >= 5_000 || callSweepCount >= 2) flags.push("Unusual Call Volume");
  if (callSweepCount >= 2) flags.push("Repeated Bullish Call Sweeps");
  if (openingCallCount >= 2) flags.push("Opening Call Activity");

  const stronglyBearish = putPremium >= Math.max(250_000, callPremium * 2.2) || bearishRowCount >= bullishRowCount + 5;
  const signal: OptionsFlowSignal = totalPremium <= 0
    ? "neutral"
    : stronglyBearish || putPremium >= Math.max(100_000, callPremium * 1.35)
      ? "bearish"
      : callPremium >= Math.max(100_000, putPremium * 1.35) || bullishRowCount >= bearishRowCount + 3
        ? "bullish"
        : "mixed";
  if (signal === "bearish") flags.push(stronglyBearish ? "Bearish Flow Veto" : "Good Chart, Weak Sponsorship");
  const score = signal === "bullish" ? 45 : signal === "mixed" ? 24 : signal === "neutral" ? 18 : 0;
  const detail = totalPremium <= 0
    ? "Options flow unavailable or quiet."
    : "Call premium " + formatMoney(callPremium) + " vs put premium " + formatMoney(putPremium) + ".";
  return { signal, score, detail, flags, stronglyBearish };
}

export function normalizeOptionsExposure(payload: unknown, currentPrice: number): OptionsExposureEvaluation {
  const cells = exposureCells(payload, currentPrice);
  if (!cells.length) return { signal: "neutral", score: 18, detail: "Options exposure unavailable.", flags: [] };
  const below = cells.filter((cell) => cell.strike < currentPrice && cell.strike >= currentPrice * 0.95);
  const above = cells.filter((cell) => cell.strike > currentPrice && cell.strike <= currentPrice * 1.05);
  const putSupport = maxBy(below, (cell) => Math.abs(cell.putExposure));
  const callWall = maxBy(above, (cell) => Math.abs(cell.callExposure));
  const totalGamma = cells.reduce((sum, cell) => sum + cell.callExposure + cell.putExposure, 0);
  const putSupportValue = putSupport ? Math.abs(putSupport.putExposure) : 0;
  const callWallValue = callWall ? Math.abs(callWall.callExposure) : 0;
  const flags: string[] = [];

  if (putSupport && putSupportValue >= 75_000) flags.push("Put Support Below Price");
  if (callWall && callWallValue >= 75_000 && callWall.strike <= currentPrice * 1.025) flags.push("Call Wall Overhead");
  if (totalGamma < -100_000) flags.push("Squeeze-Prone Exposure");
  if (putSupportValue >= 75_000 && putSupportValue >= callWallValue * 1.2) flags.push("Supportive Gamma Structure");

  const signal: OptionsExposureSignal = callWallValue >= 100_000 && callWallValue > putSupportValue * 1.4 && (callWall?.strike ?? Infinity) <= currentPrice * 1.025
    ? "hostile"
    : totalGamma < -100_000
      ? "squeeze_prone"
      : putSupportValue >= 75_000 && putSupportValue >= callWallValue * 0.75
        ? "supportive"
        : "neutral";
  if (signal === "hostile") flags.push("Good Chart, Options Resistance");
  const score = signal === "supportive" || signal === "squeeze_prone" ? 35 : signal === "neutral" ? 18 : 0;
  const detail = "Near put support " + formatMoney(putSupportValue) + "; overhead call exposure " + formatMoney(callWallValue) + ".";
  return { signal, score, detail, flags };
}

export function normalizeDarkPool(payload: unknown, currentPrice: number): DarkPoolEvaluation {
  const levels = darkPoolLevels(payload);
  if (!levels.length) return { signal: "no_data", score: 10, detail: "No meaningful dark-pool levels returned.", flags: [] };
  const nearby = levels.filter((level) => level.price >= currentPrice * 0.95 && level.price <= currentPrice * 1.05);
  const top = maxBy(nearby.length ? nearby : levels, (level) => level.notionalValue);
  if (!top || top.notionalValue < 1_000_000) return { signal: "neutral", score: 10, detail: "Dark-pool activity was not meaningful.", flags: [] };
  const distancePct = Math.abs(top.price - currentPrice) / currentPrice;
  const flags: string[] = [];
  const signal: DarkPoolSignal = top.price <= currentPrice && distancePct <= 0.04
    ? "accumulation"
    : top.price > currentPrice && distancePct <= 0.025
      ? "distribution"
      : "neutral";
  if (signal === "accumulation") flags.push("Dark-Pool Accumulation");
  const score = signal === "accumulation" ? 20 : signal === "neutral" ? 10 : 0;
  const detail = "Largest nearby dark-pool level " + formatMoney(top.notionalValue) + " near $" + top.price.toFixed(2) + ".";
  return { signal, score, detail, flags };
}

export function normalizeMaxPain(payload: unknown, currentPrice: number, daysToExpiration?: number): MaxPainEvaluation {
  const data = recordWithFields(payload, [
    "maxPainStrikePrice", "maxPainStrike", "strike", "maxPain",
    "strikePriceInCentsWithMaxPain", "maxPainStrikePriceInCents"
  ]);
  const dollarStrike = numberValue(data?.maxPainStrikePrice, data?.maxPainStrike, data?.strike, data?.maxPain);
  const centsStrike = numberValue(data?.strikePriceInCentsWithMaxPain, data?.maxPainStrikePriceInCents);
  const maxPainStrike = dollarStrike ?? (centsStrike !== undefined ? centsStrike / 100 : undefined);
  if (maxPainStrike === undefined || !(maxPainStrike > 0) || !(currentPrice > 0)) {
    return { signal: "no_data", score: 10, detail: "Max pain unavailable.", flags: [] };
  }
  const distancePct = (currentPrice - maxPainStrike) / currentPrice;
  const nearExpiration = daysToExpiration !== undefined && daysToExpiration <= MIN_DAYS_FOR_PIN_RISK;
  if (nearExpiration && distancePct >= 0.02) {
    return {
      signal: "pin_risk",
      score: 0,
      detail: "Max pain $" + maxPainStrike.toFixed(2) + " sits below price with " + daysToExpiration + " days to expiration.",
      flags: ["Max Pain Pin Risk"]
    };
  }
  if (maxPainStrike >= currentPrice) {
    return { signal: "tailwind", score: 15, detail: "Max pain $" + maxPainStrike.toFixed(2) + " is at or above current price.", flags: [] };
  }
  return { signal: "neutral", score: 10, detail: "Max pain $" + maxPainStrike.toFixed(2) + " is not a near-term structural concern.", flags: [] };
}

export function normalizeOpenInterestChange(payload: unknown, currentPrice: number): OpenInterestChangeEvaluation {
  const rows = tickerScopedRows(payload, [
    "changeInOpenInterest", "openInterestChange", "changeOpenInterest",
    "previousOpenInterest", "priorOpenInterest", "strike", "strikePrice", "strikePriceInCents"
  ]);
  if (!rows.length) return { signal: "no_data", score: 10, detail: "Open interest change unavailable.", flags: [] };
  const nearMoney = rows.filter((row) => {
    const strike = openInterestStrike(row);
    return strike !== undefined && strike >= currentPrice * 0.95 && strike <= currentPrice * 1.15;
  });
  const relevant = nearMoney.length ? nearMoney : rows;
  const aggregateChange = sumNumbers(relevant, ["changeInOpenInterest", "openInterestChange", "changeOpenInterest"]);
  const previousOpenInterest = sumNumbers(relevant, ["previousOpenInterest", "priorOpenInterest"]);
  const percentChange = previousOpenInterest > 0 ? (aggregateChange / previousOpenInterest) * 100 : 0;
  if (aggregateChange >= MIN_OI_BUILD_CONTRACTS && percentChange >= MIN_OI_BUILD_PERCENT) {
    return {
      signal: "confirmed_build",
      score: 20,
      detail: "Call open interest built by " + Math.round(aggregateChange) + " contracts (" + percentChange.toFixed(1) + "%) overnight.",
      flags: ["Confirmed Call OI Build"]
    };
  }
  return {
    signal: "no_confirmation",
    score: 5,
    detail: "Call open interest change of " + Math.round(aggregateChange) + " contracts did not confirm fresh positioning.",
    flags: []
  };
}

export function normalizeIvRank(payload: unknown, compressionActive: boolean): IvRankEvaluation {
  const window = ivRankWindow(payload);
  if (!window) {
    return { signal: "no_data", score: 10, detail: "IV Rank unavailable.", flags: [] };
  }
  const { lastIv, windowMin, windowMax } = window;
  const rank = Math.min(1, Math.max(0, (lastIv - windowMin) / (windowMax - windowMin)));
  const percentileLabel = rank <= 1 / 3 ? "bottom third" : rank >= 2 / 3 ? "top third" : "middle third";
  const detail = "IV Rank is in the " + percentileLabel + " of its lookback window (" + Math.round(rank * 100) + "th percentile).";
  if (compressionActive && rank <= 1 / 3) {
    return { signal: "confirming", score: 20, detail, flags: ["IV Rank Confirms Compression"] };
  }
  if (compressionActive && rank >= 2 / 3) {
    return { signal: "contradicting", score: 0, detail, flags: ["IV Rank Elevated Despite Compression"] };
  }
  return { signal: "neutral", score: 10, detail, flags: [] };
}

export function normalizeFlowRanking(netFlowPayload: unknown, gainersLosersPayload: unknown): Map<string, number> {
  const ranking = new Map<string, number>();
  const rows = [...payloadRows(netFlowPayload), ...payloadRows(gainersLosersPayload)];
  for (const row of rows) {
    const ticker = normalizedString(row.ticker, row.symbol).toUpperCase();
    if (!ticker) continue;
    const premium = Math.abs(numberValue(row.netPremium, row.totalPremium, row.premium) ?? 0)
      + Math.abs(numberValue(row.netCallPremium) ?? 0)
      + Math.abs(numberValue(row.netPutPremium) ?? 0);
    const percentChange = Math.abs(numberValue(row.percentChange, row.changePercent) ?? 0);
    const score = premium + percentChange * 1_000_000;
    ranking.set(ticker, (ranking.get(ticker) ?? 0) + score);
  }
  return ranking;
}

function summarizePositioning(
  flow: OptionsFlowEvaluation,
  exposure: OptionsExposureEvaluation,
  darkPool: DarkPoolEvaluation,
  maxPain: MaxPainEvaluation,
  oiChange: OpenInterestChangeEvaluation,
  ivRank: IvRankEvaluation,
  warnings: string[]
): InstitutionalPositioningSummary {
  const flags = unique([...flow.flags, ...exposure.flags, ...darkPool.flags, ...maxPain.flags, ...oiChange.flags, ...ivRank.flags]);
  const score = Math.round(flow.score + exposure.score + darkPool.score + maxPain.score + oiChange.score + ivRank.score);
  const structurallySupportive = exposure.signal === "supportive" || exposure.signal === "squeeze_prone" || darkPool.signal === "accumulation";
  const flowConfirmedByOi = flow.signal === "bullish" && oiChange.signal === "confirmed_build";
  const status: InstitutionalPositioningStatus = flow.stronglyBearish || (flow.signal === "bearish" && (exposure.signal === "hostile" || darkPool.signal === "distribution"))
    ? "vetoed"
    : flow.signal === "bearish" || exposure.signal === "hostile" || darkPool.signal === "distribution" || maxPain.signal === "pin_risk"
      ? "capped"
      : flowConfirmedByOi && structurallySupportive
        ? "confirmed"
        : "neutral";
  const confirmingFactorCount = [
    flow.signal === "bullish",
    exposure.signal === "supportive" || exposure.signal === "squeeze_prone",
    darkPool.signal === "accumulation",
    oiChange.signal === "confirmed_build",
    ivRank.signal === "confirming"
  ].filter(Boolean).length;
  const vetoingFactorCount = [
    exposure.signal === "hostile",
    maxPain.signal === "pin_risk"
  ].filter(Boolean).length;
  const reason = [
    "Flow: " + flow.detail,
    "Exposure: " + exposure.detail,
    "Dark pool: " + darkPool.detail,
    "Max pain: " + maxPain.detail,
    "OI change: " + oiChange.detail,
    "IV Rank: " + ivRank.detail
  ].join(" ");
  return {
    score,
    optionsFlowSignal: flow.signal,
    optionsExposureSignal: exposure.signal,
    darkPoolSignal: darkPool.signal,
    maxPainSignal: maxPain.signal,
    openInterestChangeSignal: oiChange.signal,
    ivRankSignal: ivRank.signal,
    status,
    reason,
    flags,
    warnings,
    confirmingFactorCount,
    vetoingFactorCount
  };
}

// QuantData wraps each tool response in an envelope — the public REST API uses
// `data`, the underlying platform API uses `response` — and often nests a
// symbol's payload one level under its ticker key. endpointBody unwraps the
// envelope; recordWithFields/tickerScopedRows additionally dig one ticker level
// when the fields aren't present at the top, while still accepting a flat shape.
function endpointBody(payload: unknown): Record<string, unknown> | undefined {
  const root = objectValue(payload);
  if (!root) return undefined;
  return objectValue(root.response) ?? objectValue(root.data) ?? root;
}

function recordWithFields(payload: unknown, fields: string[]): Record<string, unknown> | undefined {
  const data = endpointBody(payload);
  if (!data) return undefined;
  if (hasAnyField(data, fields)) return data;
  for (const value of Object.values(data)) {
    const nested = objectValue(value);
    if (nested && hasAnyField(nested, fields)) return nested;
  }
  return undefined;
}

function tickerScopedRows(payload: unknown, fields: string[]): Record<string, unknown>[] {
  // The platform API returns some endpoints (e.g. open-interest change) as a
  // bare list under `response`; unwrap that before falling back to payloadRows.
  const root = objectValue(payload);
  const envelope = root?.response ?? root?.data ?? payload;
  const direct = payloadRows(Array.isArray(envelope) ? envelope : payload);
  if (direct.some((row) => hasAnyField(row, fields))) return direct;
  const data = endpointBody(payload);
  if (!data) return direct;
  const nested = Object.values(data).flatMap((value) => payloadRows(value));
  const matching = nested.filter((row) => hasAnyField(row, fields));
  return matching.length ? matching : direct;
}

function hasAnyField(obj: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => obj[field] !== undefined);
}

// IV Rank's real shape is sessionDateToIVRankData -> <date> -> contractTypeToIVData
// -> CALL|PUT -> { lastIV, windowMinIV, windowMaxIV }. We take the most recent
// session and prefer CALL. A flat { lastIv, windowMin, windowMax } shape is also
// accepted so simpler payloads keep working.
function ivRankWindow(payload: unknown): { lastIv: number; windowMin: number; windowMax: number } | undefined {
  const body = endpointBody(payload);
  const sessionMap = objectValue(body?.sessionDateToIVRankData);
  if (sessionMap) {
    const dates = Object.keys(sessionMap).sort();
    const latest = objectValue(sessionMap[dates[dates.length - 1]]);
    const byType = objectValue(latest?.contractTypeToIVData) ?? latest;
    const cell = objectValue(byType?.CALL) ?? objectValue(byType?.PUT) ?? firstObject(Object.values(byType ?? {}));
    const nested = ivRankFromCell(cell);
    if (nested) return nested;
  }
  const flat = recordWithFields(payload, [
    "lastIv", "iv", "currentIv", "lastIV", "windowMin", "ivRankLow", "low", "windowMinIV",
    "windowMax", "ivRankHigh", "high", "windowMaxIV"
  ]);
  return ivRankFromCell(flat);
}

// Strikes arrive either as dollars (`strike`/`strikePrice`) or cents
// (`strikePriceInCents`). Normalize to dollars.
function openInterestStrike(row: Record<string, unknown>): number | undefined {
  const dollars = numberValue(row.strike, row.strikePrice);
  if (dollars !== undefined) return dollars;
  const cents = numberValue(row.strikePriceInCents);
  return cents !== undefined ? cents / 100 : undefined;
}

function ivRankFromCell(cell: Record<string, unknown> | undefined): { lastIv: number; windowMin: number; windowMax: number } | undefined {
  if (!cell) return undefined;
  const lastIv = numberValue(cell.lastIV, cell.lastIv, cell.iv, cell.currentIv);
  const windowMin = numberValue(cell.windowMinIV, cell.windowMin, cell.ivRankLow, cell.low);
  const windowMax = numberValue(cell.windowMaxIV, cell.windowMax, cell.ivRankHigh, cell.high);
  if (lastIv === undefined || windowMin === undefined || windowMax === undefined || windowMax <= windowMin) return undefined;
  return { lastIv, windowMin, windowMax };
}

// Reports the top-level keys of a response body so a still-unrecognized shape
// surfaces as an actionable scan warning instead of a silent "No Data".
function describeBodyKeys(payload: unknown): string {
  const root = objectValue(payload);
  const envelope = root?.response ?? root?.data ?? payload;
  if (Array.isArray(envelope)) {
    const first = envelope.find(isObject);
    return first ? `list[{${Object.keys(first).slice(0, 8).join(", ")}}]` : "list[]";
  }
  const body = objectValue(envelope);
  if (!body) return typeof payload;
  return `{${Object.keys(body).slice(0, 10).join(", ")}}`;
}

function payloadRows(payload: unknown): Record<string, unknown>[] {
  const data = objectValue(payload)?.data ?? payload;
  if (Array.isArray(data)) return data.filter(isObject);
  if (isObject(data)) {
    const values = Object.values(data);
    if (values.every(isObject)) return values as Record<string, unknown>[];
    const rows = [data, ...values.flatMap((value) => Array.isArray(value) ? value.filter(isObject) : [])];
    return rows.filter(isObject);
  }
  return [];
}

function exposureCells(payload: unknown, fallbackPrice: number): { strike: number; callExposure: number; putExposure: number }[] {
  const body = endpointBody(payload);
  // Real QuantData shape: expirationDateToStrikePriceInCentsToContractExposureMap
  // -> <exp> -> <strikeInCents> -> { CALL, PUT }. Strikes are in cents.
  const centsMap = objectValue(body?.expirationDateToStrikePriceInCentsToContractExposureMap)
    ?? objectValue(firstObject(Object.values(body ?? {}))?.expirationDateToStrikePriceInCentsToContractExposureMap);
  const centsCells: { strike: number; callExposure: number; putExposure: number }[] = [];
  for (const expiration of Object.values(centsMap ?? {})) {
    const strikes = objectValue(expiration);
    for (const [strikeText, cellValue] of Object.entries(strikes ?? {})) {
      const cell = objectValue(cellValue);
      const strike = Number(strikeText) / 100;
      if (!Number.isFinite(strike) || !cell) continue;
      centsCells.push({
        strike,
        callExposure: numberValue(cell.CALL, cell.call, cell.callExposure) ?? 0,
        putExposure: numberValue(cell.PUT, cell.put, cell.putExposure) ?? 0
      });
    }
  }
  if (centsCells.length) return centsCells;

  // Legacy/simple shape: <ticker>.exposureMap -> <exp> -> <strike(dollars)> -> { callExposure, putExposure }.
  const tickerEntry = firstObject(Object.values(body ?? {})) ?? body;
  const exposureMap = objectValue(tickerEntry?.exposureMap ?? body?.exposureMap);
  const cells: { strike: number; callExposure: number; putExposure: number }[] = [];
  for (const expiration of Object.values(exposureMap ?? {})) {
    const strikes = objectValue(expiration);
    for (const [strikeText, cellValue] of Object.entries(strikes ?? {})) {
      const cell = objectValue(cellValue);
      const strike = Number(strikeText);
      if (!Number.isFinite(strike) || !cell) continue;
      cells.push({
        strike,
        callExposure: numberValue(cell.callExposure, cell.callGammaExposure, cell.gammaCallExposure, cell.CALL) ?? 0,
        putExposure: numberValue(cell.putExposure, cell.putGammaExposure, cell.gammaPutExposure, cell.PUT) ?? 0
      });
    }
  }
  if (cells.length) return cells;
  return payloadRows(payload).map((row) => ({
    strike: numberValue(row.strike, row.strikePrice) ?? (numberValue(row.strikePriceInCents) ?? fallbackPrice * 100) / 100,
    callExposure: numberValue(row.callExposure, row.callGammaExposure, row.CALL) ?? 0,
    putExposure: numberValue(row.putExposure, row.putGammaExposure, row.PUT) ?? 0
  })).filter((cell) => Number.isFinite(cell.strike));
}

function darkPoolLevels(payload: unknown): { price: number; notionalValue: number }[] {
  const root = objectValue(payload);
  const data = objectValue(root?.data ?? payload);
  const levels: { price: number; notionalValue: number }[] = [];
  for (const [priceText, value] of Object.entries(data ?? {})) {
    const row = objectValue(value);
    const price = Number(priceText);
    const notionalValue = numberValue(row?.notionalValue, row?.premium, row?.value) ?? 0;
    if (Number.isFinite(price) && notionalValue > 0) levels.push({ price, notionalValue });
  }
  return levels;
}

function quantDataUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/$/, "") + path;
}

function isFresh(value: string, ttlMs: number, now: Date): boolean {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) && now.getTime() - parsed < ttlMs;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstObject(values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isObject);
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,%]/g, "")) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function sumNumbers(rows: Record<string, unknown>[], fields: string[]): number {
  return rows.reduce((sum, row) => sum + (numberValue(...fields.map((field) => row[field])) ?? 0), 0);
}

function normalizedString(...values: unknown[]): string {
  return values.find((value) => typeof value === "string")?.toString().toLowerCase() ?? "";
}

function booleanish(...values: unknown[]): boolean {
  return values.some((value) => value === true || value === "true" || value === "yes" || value === 1);
}

function maxBy<T>(items: T[], select: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => best === undefined || select(item) > select(best) ? item : best, undefined);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function marketDateUtc(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function isUsMarketHoliday(date: Date): boolean {
  const target = isoDate(date);
  const year = date.getUTCFullYear();
  const holidays = [
    observedFixedHoliday(year - 1, 1, 1),
    observedFixedHoliday(year, 1, 1),
    observedFixedHoliday(year + 1, 1, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 6, 19),
    observedFixedHoliday(year, 7, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 12, 25)
  ];
  return holidays.some((holiday) => isoDate(holiday) === target);
}

function observedFixedHoliday(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) return addDays(date, -1);
  if (date.getUTCDay() === 0) return addDays(date, 1);
  return date;
}

function nthWeekdayOfMonth(year: number, monthIndex: number, weekday: number, occurrence: number): Date {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, offset + (occurrence - 1) * 7);
}

function lastWeekdayOfMonth(year: number, monthIndex: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function formatMoney(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (absolute >= 1_000_000) return "$" + (value / 1_000_000).toFixed(1) + "M";
  if (absolute >= 1_000) return "$" + Math.round(value / 1_000) + "K";
  return "$" + Math.round(value);
}
