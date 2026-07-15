import type {
  OptionsPositioningSummary,
  MaxPainSignal,
  OpenInterestChangeSignal,
  OptionContract,
  OptionsExposureSignal,
  OptionsFlowSignal
} from "../shared/types";
import { fetchOptionsForPositioning } from "./schwab";
import { getSetting, setSetting } from "./sqlite";

export type SchwabPositioningEnrichContext = {
  nearestExpirationDate?: string;
};

export type SchwabPositioningResult = {
  positioning: OptionsPositioningSummary;
  warnings: string[];
  usedLive: boolean;
};

export type SchwabPositioningSessionSnapshot = {
  sessionDate: string;
  observedAt: string;
  callOpenInterest: number;
  callContracts: Record<string, number>;
};

type SymbolSnapshotHistory = {
  updatedAt: string;
  sessions: SchwabPositioningSessionSnapshot[];
};

export type SchwabPositioningCache = {
  version: 2;
  symbols: Record<string, SymbolSnapshotHistory>;
};

export type OptionsActivity = {
  signal: OptionsFlowSignal;
  callVolume: number;
  putVolume: number;
  callPremium: number;
  putPremium: number;
  callOpenInterest: number;
  putOpenInterest: number;
  callVolumeToOpenInterest?: number;
  putVolumeToOpenInterest?: number;
  detail: string;
  flags: string[];
};

export type GammaWall = {
  strike: number;
  dollarGammaPerOnePercentMove: number;
};

export type GammaWallAnalysis = {
  signal: OptionsExposureSignal;
  putConcentration?: GammaWall;
  callConcentration?: GammaWall;
  detail: string;
  flags: string[];
};

export type MaxPainAnalysis = {
  signal: MaxPainSignal;
  expirationDate?: string;
  strike?: number;
  detail: string;
  flags: string[];
};

export type OpenInterestBuildAnalysis = {
  signal: OpenInterestChangeSignal;
  change: number;
  percentChange: number;
  detail: string;
  flags: string[];
};

type ChainLoader = (symbol: string, price: number) => Promise<OptionContract[]>;

const CACHE_KEY = "schwabPositioningSnapshotsV2";
const MAX_SESSIONS_PER_SYMBOL = 2;
const DEFAULT_MAX_CACHE_SYMBOLS = 250;
const MAX_OI_COHORT_CONTRACTS = 40;
const MIN_OI_COHORT_COVERAGE = 0.8;
const MIN_ACTIVITY_VOLUME = 250;
const MIN_ACTIVITY_PREMIUM = 25_000;
const ACTIVITY_SKEW_RATIO = 1.5;
const MIN_OI_BUILD_CONTRACTS = 500;
const MIN_OI_BUILD_PERCENT = 5;
const MIN_GAMMA_WALL_DOLLARS = 75_000;

const EMPTY_POSITIONING: OptionsPositioningSummary = {
  score: 50,
  optionsFlowSignal: "neutral",
  optionsExposureSignal: "neutral",
  darkPoolSignal: "no_data",
  maxPainSignal: "no_data",
  openInterestChangeSignal: "no_data",
  ivRankSignal: "no_data",
  status: "neutral",
  reason: "Schwab options positioning was unavailable; technical grade and trade mark were unchanged.",
  flags: [],
  warnings: [],
  confirmingFactorCount: 0,
  vetoingFactorCount: 0
};

export async function createSchwabPositioningScanProvider() {
  const cache = await getSetting<SchwabPositioningCache>(CACHE_KEY, { version: 2, symbols: {} });
  const provider = createSchwabPositioningProvider({ cache });
  return {
    ...provider,
    async flush() {
      if (provider.isDirty()) await setSetting(CACHE_KEY, provider.cache());
    }
  };
}

export function createSchwabPositioningProvider(input: {
  loadChain?: ChainLoader;
  cache?: SchwabPositioningCache;
  now?: () => Date;
  maxCacheSymbols?: number;
}) {
  const loadChain = input.loadChain ?? fetchOptionsForPositioning;
  const now = input.now ?? (() => new Date());
  const maxCacheSymbols = Math.max(1, input.maxCacheSymbols ?? DEFAULT_MAX_CACHE_SYMBOLS);
  let snapshotCache = pruneSnapshotCache(input.cache, maxCacheSymbols);
  let dirty = false;

  async function enrich(
    symbol: string,
    price: number,
    context: SchwabPositioningEnrichContext = {}
  ): Promise<SchwabPositioningResult> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !Number.isFinite(price) || price <= 0) {
      return noDataResult("Schwab options positioning needs a valid symbol and underlying price.", false);
    }

    let loaded: OptionContract[];
    try {
      loaded = await loadChain(upperSymbol, price);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schwab option-chain request failed.";
      return noDataResult(message, true);
    }

    const contracts = uniqueContracts(loaded)
      .filter((contract) => contract.dte === undefined || (contract.dte >= 14 && contract.dte <= 180));
    if (!contracts.length) return noDataResult("Schwab returned no 14-180 DTE call/put contracts for positioning.", true);

    const activity = analyzeOptionsActivity(contracts);
    const observedAt = now();
    const currentCallContracts = callOpenInterestBySymbol(contracts);
    const persistedCallContracts = topOpenInterestCohort(currentCallContracts);
    const currentSnapshot: SchwabPositioningSessionSnapshot = {
      sessionDate: observationSessionDate(observedAt),
      observedAt: observedAt.toISOString(),
      callOpenInterest: sum(Object.values(persistedCallContracts), (value) => value),
      callContracts: persistedCallContracts
    };
    const previousSnapshot = snapshotCache.symbols[upperSymbol]?.sessions
      .filter((snapshot) => snapshot.sessionDate !== currentSnapshot.sessionDate)
      .sort((left, right) => right.sessionDate.localeCompare(left.sessionDate))[0];
    const openInterest = evaluateOpenInterestBuild({
      ...currentSnapshot,
      callOpenInterest: activity.callOpenInterest,
      callContracts: currentCallContracts
    }, previousSnapshot);
    upsertSnapshot(upperSymbol, currentSnapshot);

    const gamma = calculateGammaWalls(contracts, price);
    const maxPain = calculateMaxPain(
      contracts,
      price,
      context.nearestExpirationDate
    );
    return {
      positioning: summarizeSchwabPositioning(activity, gamma, maxPain, openInterest),
      warnings: [],
      usedLive: true
    };
  }

  function upsertSnapshot(symbol: string, snapshot: SchwabPositioningSessionSnapshot) {
    const prior = snapshotCache.symbols[symbol]?.sessions ?? [];
    const sessions = [...prior.filter((item) => item.sessionDate !== snapshot.sessionDate), snapshot]
      .sort((left, right) => right.sessionDate.localeCompare(left.sessionDate))
      .slice(0, MAX_SESSIONS_PER_SYMBOL)
      .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
    snapshotCache.symbols[symbol] = { updatedAt: snapshot.observedAt, sessions };
    snapshotCache = pruneSnapshotCache(snapshotCache, maxCacheSymbols);
    dirty = true;
  }

  return {
    enrich,
    cache: () => snapshotCache,
    isDirty: () => dirty
  };
}

/**
 * Gross premium is volume multiplied by the midpoint (or last price) and the
 * 100-share option multiplier. It is activity, not buyer/seller direction.
 */
export function analyzeOptionsActivity(input: OptionContract[]): OptionsActivity {
  const contracts = uniqueContracts(input);
  const calls = contracts.filter((contract) => contract.optionType === "call");
  const puts = contracts.filter((contract) => contract.optionType === "put");
  const callVolume = sum(calls, (contract) => nonNegative(contract.volume));
  const putVolume = sum(puts, (contract) => nonNegative(contract.volume));
  const callOpenInterest = sum(calls, (contract) => nonNegative(contract.openInterest));
  const putOpenInterest = sum(puts, (contract) => nonNegative(contract.openInterest));
  const callPremium = sum(calls, approximateContractPremium);
  const putPremium = sum(puts, approximateContractPremium);
  const callVolumeToOpenInterest = callOpenInterest > 0 ? callVolume / callOpenInterest : undefined;
  const putVolumeToOpenInterest = putOpenInterest > 0 ? putVolume / putOpenInterest : undefined;
  const callSkew = callVolume >= MIN_ACTIVITY_VOLUME
    && callPremium >= MIN_ACTIVITY_PREMIUM
    && callVolume >= putVolume * ACTIVITY_SKEW_RATIO
    && callPremium >= putPremium * ACTIVITY_SKEW_RATIO;
  const putSkew = putVolume >= MIN_ACTIVITY_VOLUME
    && putPremium >= MIN_ACTIVITY_PREMIUM
    && putVolume >= callVolume * ACTIVITY_SKEW_RATIO
    && putPremium >= callPremium * ACTIVITY_SKEW_RATIO;
  const signal: OptionsFlowSignal = callSkew ? "bullish" : putSkew || callVolume + putVolume > 0 ? "mixed" : "neutral";
  const flags = callSkew ? ["Call-Skewed Options Activity"] : putSkew ? ["Put-Skewed Options Activity"] : [];
  const detail = "Gross call activity " + formatMoney(callPremium) + " / " + Math.round(callVolume)
    + " contracts (volume/OI " + formatRatio(callVolumeToOpenInterest) + ") versus puts "
    + formatMoney(putPremium) + " / " + Math.round(putVolume) + " contracts (volume/OI "
    + formatRatio(putVolumeToOpenInterest) + "). Premium is midpoint/last × volume, not aggressor-side flow.";
  return {
    signal,
    callVolume,
    putVolume,
    callPremium,
    putPremium,
    callOpenInterest,
    putOpenInterest,
    callVolumeToOpenInterest,
    putVolumeToOpenInterest,
    detail,
    flags
  };
}

/**
 * Dollar gamma per 1% underlying move = |gamma| × OI × 100 × spot² × 1%.
 * Calls and puts are intentionally kept as unsigned concentrations because
 * Schwab does not expose customer/dealer ownership or opening/closing intent.
 */
export function calculateGammaWalls(input: OptionContract[], price: number): GammaWallAnalysis {
  if (!Number.isFinite(price) || price <= 0) {
    return { signal: "neutral", detail: "Gamma concentration unavailable.", flags: [] };
  }
  const byStrike = new Map<number, { call: number; put: number }>();
  for (const contract of uniqueContracts(input)) {
    const gamma = Math.abs(contract.gamma ?? 0);
    const openInterest = nonNegative(contract.openInterest);
    if (!(gamma > 0) || !(openInterest > 0) || !(contract.strike > 0)) continue;
    const dollars = gamma * openInterest * 100 * price * price * 0.01;
    const cell = byStrike.get(contract.strike) ?? { call: 0, put: 0 };
    cell[contract.optionType] += dollars;
    byStrike.set(contract.strike, cell);
  }
  const putConcentration = largestWall(
    [...byStrike].filter(([strike]) => strike <= price && strike >= price * 0.9),
    "put"
  );
  const callConcentration = largestWall(
    [...byStrike].filter(([strike]) => strike >= price && strike <= price * 1.1),
    "call"
  );
  if (!putConcentration && !callConcentration) {
    return {
      signal: "neutral",
      detail: "Schwab gamma/OI was unavailable; exposure stayed neutral.",
      flags: []
    };
  }

  const flags: string[] = [];
  if (putConcentration && putConcentration.dollarGammaPerOnePercentMove >= MIN_GAMMA_WALL_DOLLARS) {
    flags.push("Put Gamma Concentration Below Price");
  }
  if (callConcentration
    && callConcentration.dollarGammaPerOnePercentMove >= MIN_GAMMA_WALL_DOLLARS
    && callConcentration.strike <= price * 1.025) flags.push("Call Gamma Concentration Near Price");
  const detail = "Unsigned gamma concentration (|gamma| × OI × 100 × spot² × 1%): put "
    + wallLabel(putConcentration) + "; call " + wallLabel(callConcentration)
    + ". Dealer sign is unknown, so these are concentration markers—not support, resistance, or a directional signal.";
  return { signal: "neutral", putConcentration, callConcentration, detail, flags };
}

export function calculateMaxPain(
  input: OptionContract[],
  price: number,
  requestedExpiration?: string
): MaxPainAnalysis {
  const contracts = uniqueContracts(input).filter((contract) => contract.openInterest > 0 && contract.strike > 0);
  const requested = requestedExpiration?.slice(0, 10);
  const expirationDates = [...new Set(contracts.map((contract) => contract.expirationDate.slice(0, 10)).filter(Boolean))].sort();
  const expirationDate = requested && expirationDates.includes(requested) ? requested : expirationDates.find((date) => {
    const rows = contracts.filter((contract) => contract.expirationDate.slice(0, 10) === date);
    return rows.some((contract) => contract.optionType === "call") && rows.some((contract) => contract.optionType === "put");
  });
  if (!expirationDate || !(price > 0)) {
    return { signal: "no_data", detail: "Max pain unavailable from the Schwab chain.", flags: [] };
  }
  const rows = contracts.filter((contract) => contract.expirationDate.slice(0, 10) === expirationDate);
  if (!rows.some((contract) => contract.optionType === "call") || !rows.some((contract) => contract.optionType === "put")) {
    return { signal: "no_data", detail: "Max pain needs both call and put open interest for one expiration.", flags: [] };
  }
  let strike: number | undefined;
  let minimumPayout = Number.POSITIVE_INFINITY;
  for (const settlement of [...new Set(rows.map((contract) => contract.strike))].sort((left, right) => left - right)) {
    const payout = sum(rows, (contract) => {
      const intrinsic = contract.optionType === "call"
        ? Math.max(0, settlement - contract.strike)
        : Math.max(0, contract.strike - settlement);
      return intrinsic * contract.openInterest * 100;
    });
    if (payout < minimumPayout) {
      minimumPayout = payout;
      strike = settlement;
    }
  }
  if (strike === undefined) return { signal: "no_data", detail: "Max pain unavailable from the Schwab chain.", flags: [] };

  const detail = "Schwab OI max pain for " + expirationDate + " is $" + strike.toFixed(2)
    + ". It uses the bounded returned strike window and is informational—not a directional forecast.";
  return { signal: "neutral", expirationDate, strike, detail, flags: [] };
}

export function evaluateOpenInterestBuild(
  current: SchwabPositioningSessionSnapshot,
  previous?: SchwabPositioningSessionSnapshot
): OpenInterestBuildAnalysis {
  if (!previous || previous.sessionDate !== previousTradingSessionDate(current.sessionDate)) {
    return {
      signal: "no_data",
      change: 0,
      percentChange: 0,
      detail: "The immediately preceding trading-session Schwab OI snapshot is required for confirmation.",
      flags: []
    };
  }
  const priorContracts = Object.entries(previous.callContracts ?? {});
  const matched = priorContracts.filter(([symbol]) => Object.hasOwn(current.callContracts ?? {}, symbol));
  const priorMatchedOpenInterest = sum(matched, ([, openInterest]) => nonNegative(openInterest));
  const currentMatchedOpenInterest = sum(matched, ([symbol]) => nonNegative(current.callContracts[symbol]));
  const coverage = previous.callOpenInterest > 0 ? priorMatchedOpenInterest / previous.callOpenInterest : 0;
  const minimumMatchedContracts = Math.min(5, priorContracts.length);
  if (!priorContracts.length || matched.length < minimumMatchedContracts || coverage < MIN_OI_COHORT_COVERAGE) {
    return {
      signal: "no_data",
      change: 0,
      percentChange: 0,
      detail: "The returned chain covered " + (coverage * 100).toFixed(0)
        + "% of the fixed prior-session call-OI cohort; at least " + (MIN_OI_COHORT_COVERAGE * 100)
        + "% is required for comparison.",
      flags: []
    };
  }
  const change = currentMatchedOpenInterest - priorMatchedOpenInterest;
  const percentChange = priorMatchedOpenInterest > 0 ? (change / priorMatchedOpenInterest) * 100 : 0;
  const confirmed = change >= MIN_OI_BUILD_CONTRACTS && percentChange >= MIN_OI_BUILD_PERCENT;
  return {
    signal: confirmed ? "confirmed_build" : "no_confirmation",
    change,
    percentChange,
    detail: confirmed
      ? "The fixed prior-session call-OI cohort increased by " + Math.round(change) + " contracts (" + percentChange.toFixed(1) + "%) versus " + previous.sessionDate + "."
      : "The fixed prior-session call-OI cohort changed by " + Math.round(change) + " contracts (" + percentChange.toFixed(1) + "%) versus " + previous.sessionDate + "; no confirmed build.",
    flags: confirmed ? ["Confirmed Call OI Build"] : []
  };
}

export function observationSessionDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(numberPart("year"), numberPart("month") - 1, numberPart("day")));
  while (isWeekend(date) || isUsMarketHoliday(date)) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function previousTradingSessionDate(sessionDate: string): string {
  let date = addDays(new Date(sessionDate + "T12:00:00.000Z"), -1);
  while (isWeekend(date) || isUsMarketHoliday(date)) date = addDays(date, -1);
  return date.toISOString().slice(0, 10);
}

function isWeekend(date: Date): boolean {
  return date.getUTCDay() === 0 || date.getUTCDay() === 6;
}

function isUsMarketHoliday(date: Date): boolean {
  const target = date.toISOString().slice(0, 10);
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
  return holidays.some((holiday) => holiday.toISOString().slice(0, 10) === target);
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function summarizeSchwabPositioning(
  activity: OptionsActivity,
  gamma: GammaWallAnalysis,
  maxPain: MaxPainAnalysis,
  openInterest: OpenInterestBuildAnalysis
): OptionsPositioningSummary {
  const flowConfirmedByOi = activity.signal === "bullish" && openInterest.signal === "confirmed_build";
  const status = flowConfirmedByOi ? "confirmed" : "neutral";
  const score = Math.min(100, 50
    + (activity.signal === "bullish" ? 10 : 0)
    + (openInterest.signal === "confirmed_build" ? 20 : 0)
    + (flowConfirmedByOi ? 20 : 0));
  const flags = uniqueStrings([...activity.flags, ...gamma.flags, ...maxPain.flags, ...openInterest.flags]);
  const confirmingFactorCount = flowConfirmedByOi ? 2 : 0;
  const reason = [
    "Options activity: " + activity.detail,
    "Gamma concentration: " + gamma.detail,
    "Max pain: " + maxPain.detail,
    "OI confirmation: " + openInterest.detail,
    "Dark-pool and IV Rank data are not available from this Schwab snapshot."
  ].join(" ");
  return {
    score,
    optionsFlowSignal: activity.signal,
    optionsExposureSignal: gamma.signal,
    darkPoolSignal: "no_data",
    maxPainSignal: maxPain.signal,
    openInterestChangeSignal: openInterest.signal,
    ivRankSignal: "no_data",
    status,
    reason,
    flags,
    warnings: [],
    confirmingFactorCount,
    vetoingFactorCount: 0
  };
}

function noDataResult(message: string, usedLive: boolean): SchwabPositioningResult {
  const warnings = [message];
  return {
    positioning: { ...EMPTY_POSITIONING, warnings, reason: message + " Technical grade and trade mark were unchanged." },
    warnings,
    usedLive
  };
}

function pruneSnapshotCache(cache: SchwabPositioningCache | undefined, maxSymbols: number): SchwabPositioningCache {
  const entries = Object.entries(cache?.symbols ?? {}).flatMap(([rawSymbol, history]) => {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || !history || !Array.isArray(history.sessions)) return [];
    const bySession = new Map<string, SchwabPositioningSessionSnapshot>();
    for (const snapshot of history.sessions) {
      if (!validSnapshot(snapshot)) continue;
      const existing = bySession.get(snapshot.sessionDate);
      if (!existing || existing.observedAt < snapshot.observedAt) bySession.set(snapshot.sessionDate, snapshot);
    }
    const sessions = [...bySession.values()]
      .sort((left, right) => right.sessionDate.localeCompare(left.sessionDate))
      .slice(0, MAX_SESSIONS_PER_SYMBOL)
      .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
    if (!sessions.length) return [];
    const updatedAt = sessions[sessions.length - 1].observedAt;
    return [[symbol, { updatedAt, sessions }] as const];
  });
  entries.sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt));
  return { version: 2, symbols: Object.fromEntries(entries.slice(0, maxSymbols)) };
}

function validSnapshot(value: SchwabPositioningSessionSnapshot): boolean {
  const contracts = Object.entries(value?.callContracts ?? {});
  const callOpenInterest = sum(contracts, ([, openInterest]) => nonNegative(openInterest));
  return Boolean(value
    && /^\d{4}-\d{2}-\d{2}$/.test(value.sessionDate)
    && Number.isFinite(Date.parse(value.observedAt))
    && Number.isFinite(value.callOpenInterest)
    && value.callOpenInterest >= 0
    && contracts.length > 0
    && contracts.length <= MAX_OI_COHORT_CONTRACTS
    && contracts.every(([symbol, openInterest]) => Boolean(symbol) && Number.isFinite(openInterest) && openInterest >= 0)
    && Math.abs(callOpenInterest - value.callOpenInterest) < 0.001);
}

function uniqueContracts(input: OptionContract[]): OptionContract[] {
  const output = new Map<string, OptionContract>();
  for (const contract of input) {
    if (!contract || ![contract.strike, contract.volume, contract.openInterest].every(Number.isFinite)) continue;
    const key = contract.symbol || [contract.optionType, contract.expirationDate.slice(0, 10), contract.strike].join(":");
    if (!output.has(key)) output.set(key, contract);
  }
  return [...output.values()];
}

function callOpenInterestBySymbol(input: OptionContract[]): Record<string, number> {
  return Object.fromEntries(uniqueContracts(input)
    .filter((contract) => contract.optionType === "call" && Boolean(contract.symbol))
    .map((contract) => [contract.symbol, nonNegative(contract.openInterest)]));
}

function topOpenInterestCohort(contracts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(contracts)
    .sort(([leftSymbol, leftOi], [rightSymbol, rightOi]) => rightOi - leftOi || leftSymbol.localeCompare(rightSymbol))
    .slice(0, MAX_OI_COHORT_CONTRACTS));
}

function approximateContractPremium(contract: OptionContract): number {
  const bid = nonNegative(contract.bid);
  const ask = nonNegative(contract.ask);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const price = midpoint || nonNegative(contract.last);
  return nonNegative(contract.volume) * price * 100;
}

function largestWall(entries: Array<[number, { call: number; put: number }]>, side: "call" | "put"): GammaWall | undefined {
  let largest: GammaWall | undefined;
  for (const [strike, cell] of entries) {
    if (!(cell[side] > (largest?.dollarGammaPerOnePercentMove ?? 0))) continue;
    largest = { strike, dollarGammaPerOnePercentMove: cell[side] };
  }
  return largest;
}

function wallLabel(wall: GammaWall | undefined): string {
  return wall ? formatMoney(wall.dollarGammaPerOnePercentMove) + " near $" + wall.strike.toFixed(2) : "unavailable";
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(1) + "M";
  if (value >= 1_000) return "$" + Math.round(value / 1_000) + "K";
  return "$" + Math.round(value);
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "N/A" : (value * 100).toFixed(1) + "%";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
