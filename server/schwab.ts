import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { createFmpScanFallback, type FmpFundamentals } from "./fmp";
import { fetchWithRetry } from "./httpRetry";
import { deleteSetting, getSetting, setSetting } from "./sqlite";
import type { BrokerStatus, Candle, FundamentalAnalysis, FundamentalFieldSources, OptionContract, ScanResult } from "../shared/types";
import { isCompletedRegularSessionDate } from "../shared/marketTime";

export type SchwabQuote = {
  symbol: string;
  price: number;
  priceAsOf?: string;
  companyName?: string;
  volume?: number;
  averageVolume?: number;
  rootSymbols?: string[];
  avgDollarVolume?: number;
  beta?: number;
  marketCap?: number;
  eps?: number;
  peRatio?: number;
  dividendAmount?: number;
  dividendYield?: number;
  dividendFrequency?: string;
  dividendPayAmount?: number;
  explicitZeroDividend?: boolean;
  dividendPayDate?: string;
  dividendExDate?: string;
  lastEarningsDate?: string;
};

type SchwabTokens = {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string;
  refreshTokenIssuedAt?: string;
};

type SchwabTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type SchwabQuotePayload = Record<string, Record<string, unknown>>;

type SchwabPriceHistoryResponse = {
  candles?: Array<{ datetime: number; open: number; high: number; low: number; close: number; volume: number }>;
};

type SchwabOptionChainResponse = {
  callExpDateMap?: Record<string, Record<string, Array<Record<string, unknown>>>>;
  putExpDateMap?: Record<string, Record<string, Array<Record<string, unknown>>>>;
};

const TOKEN_SETTING = "schwabTokens";
const OAUTH_STATE_VERSION = "v1";
const OAUTH_STATE_WINDOW_HOURS = 24;
let tokenCache: SchwabTokens | undefined | null = null;
let refreshPromise: Promise<SchwabTokens> | null = null;

class SchwabTokenRequestError extends Error {
  constructor(readonly status: number, statusText: string, body: string) {
    super(`Schwab token request failed: ${status} ${statusText}${body ? ` - ${body.slice(0, 180)}` : ""}`);
    this.name = "SchwabTokenRequestError";
  }
}

export function hasSchwabCredentials(): boolean {
  return Boolean(config.schwabAppKey && config.schwabAppSecret && config.schwabCallbackUrl);
}

export async function hasSchwabTokens(): Promise<boolean> {
  return Boolean((await readTokens())?.accessToken);
}

export function getSchwabLoginUrl(): string {
  if (!hasSchwabCredentials()) throw new Error("SCHWAB_APP_KEY, SCHWAB_APP_SECRET, and SCHWAB_CALLBACK_URL are required.");
  const url = new URL(`${config.schwabAuthBaseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.schwabAppKey);
  url.searchParams.set("redirect_uri", config.schwabCallbackUrl);
  url.searchParams.set("state", createSchwabOAuthState());
  return url.toString();
}

export async function handleSchwabCallback(code: string, state: string): Promise<BrokerStatus> {
  if (!code) throw new Error("Schwab callback did not include an authorization code.");
  if (!isValidSchwabOAuthState(state)) throw new Error("Schwab callback state was invalid. Start the Schwab connection flow again.");
  await exchangeAuthorizationCode(code);
  return getSchwabStatus();
}

export async function getSchwabStatus(sampleSymbol = "AAPL"): Promise<BrokerStatus> {
  const base = {
    configured: hasSchwabCredentials(),
    baseUrl: config.schwabMarketDataBaseUrl,
    checkedAt: new Date().toISOString(),
    sampleSymbol
  };

  if (!hasSchwabCredentials()) {
    return {
      ...base,
      ok: false,
      needsLogin: true,
      message: "Schwab app credentials are missing. Add SCHWAB_APP_KEY, SCHWAB_APP_SECRET, and SCHWAB_CALLBACK_URL to .env."
    };
  }

  const stored = await readTokens();
  if (!stored) {
    return {
      ...base,
      ok: false,
      needsLogin: true,
      message: "Schwab credentials found. Connect Schwab to authorize market data."
    };
  }

  try {
    const quote = await fetchQuote(sampleSymbol);
    return {
      ...base,
      ok: Boolean(quote),
      needsLogin: false,
      samplePrice: quote?.price,
      message: quote ? `Connected. Latest ${sampleSymbol} quote loaded from Schwab.` : "Connected, but no sample quote was returned."
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      needsLogin: true,
      message: error instanceof Error ? error.message : "Schwab status check failed."
    };
  }
}

export async function fetchQuote(symbol: string): Promise<SchwabQuote | undefined> {
  return (await fetchQuotes([symbol])).get(symbol.toUpperCase());
}

export async function fetchFundamentalAnalysis(symbol: string, scanResult?: ScanResult): Promise<FundamentalAnalysis> {
  const upperSymbol = symbol.trim().toUpperCase();
  let quote: SchwabQuote | undefined;
  const warnings: string[] = [];

  try {
    quote = await fetchQuote(upperSymbol);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Schwab fundamentals request failed.");
  }

  if (!quote) warnings.push("Schwab did not return fundamentals for " + upperSymbol + ".");

  const fmp = await createFmpScanFallback();
  const fmpEnrichment = await fmp.enrich(upperSymbol, {
    beta: quote?.beta === undefined,
    marketCap: quote?.marketCap === undefined,
    averageVolume: quote?.averageVolume === undefined,
    sector: true,
    nextEarningsDate: true
  });
  warnings.push(...fmpEnrichment.warnings);
  await fmp.flush();

  return mergeFundamentalAnalysis({
    symbol: upperSymbol,
    schwab: quote,
    fmp: fmpEnrichment.data,
    scanResult,
    warnings
  });
}

export async function fetchQuotes(symbols: string[]): Promise<Map<string, SchwabQuote>> {
  const output = new Map<string, SchwabQuote>();
  const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  for (const batch of chunks(uniqueSymbols, 80)) {
    const data = await schwabGet<SchwabQuotePayload>("/quotes", {
      symbols: batch.join(","),
      fields: "quote,reference,fundamental"
    });
    for (const quote of normalizeSchwabQuotes(data)) {
      output.set(quote.symbol, quote);
    }
  }
  return output;
}

export async function fetchHistory(symbol: string): Promise<Candle[]> {
  return fetchDailyHistory(symbol, 5 * 366);
}

async function fetchDailyHistory(symbol: string, lookbackDays: number): Promise<Candle[]> {
  const endDate = Date.now();
  const startDate = endDate - lookbackDays * 24 * 60 * 60 * 1000;
  const data = await schwabGet<SchwabPriceHistoryResponse>("/pricehistory", {
    symbol,
    periodType: "year",
    startDate,
    endDate,
    frequencyType: "daily",
    frequency: "1",
    needExtendedHoursData: "false"
  });
  return normalizeSchwabHistory(data, { completedOnly: true });
}

export async function fetchCallOptions(symbol: string, price: number): Promise<OptionContract[]> {
  return fetchDirectionalOptions(symbol, price, "CALL");
}

/**
 * Loads the bounded 14-180 DTE chain used for positioning calculations.
 * Unlike fetchCallOptions, this intentionally preserves both puts and calls,
 * every returned strike, and contracts without a tradable two-sided quote.
 * Schwab's configured strikeCount remains the memory/network bound.
 */
export async function fetchOptionsForPositioning(symbol: string, price: number): Promise<OptionContract[]> {
  const data = await schwabGet<SchwabOptionChainResponse>("/chains", {
    symbol,
    contractType: "ALL",
    strategy: "SINGLE",
    includeUnderlyingQuote: "false",
    strikeCount: config.schwabOptionStrikeCount,
    fromDate: dateOffset(14),
    toDate: dateOffset(180)
  });
  return [
    ...normalizeSchwabCallOptions(data, price),
    ...normalizeSchwabPutOptions(data, price)
  ]
    .filter((item) => item.dte === undefined || (item.dte >= 14 && item.dte <= 180))
    .sort((left, right) => left.expirationDate.localeCompare(right.expirationDate)
      || left.strike - right.strike
      || left.optionType.localeCompare(right.optionType));
}

async function fetchDirectionalOptions(symbol: string, price: number, contractType: "CALL" | "PUT"): Promise<OptionContract[]> {
  const fromDate = dateOffset(14);
  const toDate = dateOffset(180);
  const data = await schwabGet<SchwabOptionChainResponse>("/chains", {
    symbol,
    contractType,
    strategy: "SINGLE",
    includeUnderlyingQuote: "false",
    strikeCount: config.schwabOptionStrikeCount,
    fromDate,
    toDate
  });
  const options = contractType === "CALL" ? normalizeSchwabCallOptions(data, price) : normalizeSchwabPutOptions(data, price);
  return options
    .filter((item) => item.bid > 0 && item.ask > 0 && isStrikeNearPrice(item, price))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function normalizeSchwabQuotes(data: SchwabQuotePayload, observedAt = new Date()): SchwabQuote[] {
  return Object.entries(data).flatMap(([fallbackSymbol, payload]) => {
    const quote = objectValue(payload.quote);
    const reference = objectValue(payload.reference);
    const fundamental = objectValue(payload.fundamental);
    const symbol = String(payload.symbol ?? reference.symbol ?? fallbackSymbol).toUpperCase();
    const price = firstNumber(quote.lastPrice, quote.mark, quote.closePrice, quote.bidPrice, quote.askPrice);
    if (!symbol || !price) return [];
    const averageVolume = firstNumber(
      fundamental.avg10DaysVolume,
      fundamental.avg1YearVolume,
      fundamental.averageVolume,
      fundamental.avgVolume,
      quote.averageVolume,
      quote.avgVolume
    );
    return [{
      symbol,
      price,
      priceAsOf: observedAt.toISOString(),
      companyName: stringValue(reference.description),
      volume: firstNumber(quote.totalVolume, quote.volume),
      averageVolume,
      rootSymbols: stringValue(reference.optionRoot)?.split(",").map((item) => item.trim()).filter(Boolean),
      avgDollarVolume: averageVolume ? averageVolume * price : undefined,
      beta: firstFiniteNumber(fundamental.beta, fundamental.betaCoefficient),
      marketCap: firstNumber(fundamental.marketCap, fundamental.marketCapitalization, fundamental.marketCapFloat),
      eps: firstFiniteNumber(fundamental.eps, fundamental.epsTTM, fundamental.epsTrailingTwelveMonths),
      peRatio: firstFiniteNumber(fundamental.peRatio, fundamental.peRatioTTM, fundamental.pERatio),
      dividendAmount: firstNonNegativeNumber(fundamental.dividendAmount, fundamental.divAmount, fundamental.annualDividend),
      dividendYield: firstNonNegativeNumber(fundamental.dividendYield, fundamental.divYield),
      dividendFrequency: stringValue(fundamental.dividendFrequency, fundamental.divFreq),
      dividendPayAmount: firstNonNegativeNumber(fundamental.dividendPayAmount, fundamental.divPayAmount),
      explicitZeroDividend: hasExplicitZero(fundamental.dividendAmount, fundamental.divAmount, fundamental.annualDividend)
        && hasExplicitZero(fundamental.dividendYield, fundamental.divYield),
      dividendPayDate: dateStringValue(fundamental.dividendPayDate, fundamental.divPayDate),
      dividendExDate: dateStringValue(fundamental.dividendExDate, fundamental.divExDate),
      lastEarningsDate: dateStringValue(fundamental.lastEarningsDate, fundamental.earningsDate)
    }];
  });
}

export function normalizeFundamentalAnalysis(quote: SchwabQuote, scanResult?: ScanResult): FundamentalAnalysis {
  return mergeFundamentalAnalysis({ symbol: quote.symbol, schwab: quote, scanResult, warnings: [] });
}

export function mergeFundamentalAnalysis(input: {
  symbol: string;
  schwab?: SchwabQuote;
  fmp?: FmpFundamentals;
  scanResult?: ScanResult;
  warnings: string[];
}): FundamentalAnalysis {
  const warnings = [...new Set(input.warnings.filter(Boolean))];
  const fieldSources: FundamentalFieldSources = {};
  const sourceStatus = input.schwab && input.fmp ? "mixed" : input.schwab ? "live" : input.fmp ? "fallback" : "unavailable";
  const symbol = input.schwab?.symbol ?? input.symbol;
  const marketCap = valueWithSource(input.schwab?.marketCap, "schwab", input.fmp?.marketCap, "fmp", fieldSources, "marketCap") ?? null;
  const beta = valueWithSource(input.schwab?.beta, "schwab", input.fmp?.beta, "fmp", fieldSources, "beta") ?? null;
  const averageVolume = valueWithSource(input.schwab?.averageVolume, "schwab", input.fmp?.averageVolume, "fmp", fieldSources, "avgShareVolume") ?? null;
  const sector = valueWithSource(undefined, "schwab", input.fmp?.sector, "fmp", fieldSources, "sector");
  const lastEarningsDate = valueWithSource(input.schwab?.lastEarningsDate, "schwab", undefined, "fmp", fieldSources, "lastEarningsDate");
  const nextEarningsDate = valueWithSource(input.fmp?.nextEarningsDate, "fmp", undefined, "schwab", fieldSources, "nextEarningsDate");

  return {
    symbol,
    companyName: input.schwab?.companyName ?? input.fmp?.companyName,
    price: input.schwab?.price ?? null,
    volume: input.schwab?.volume ?? null,
    averageVolume,
    avgDollarVolume: input.schwab?.avgDollarVolume ?? null,
    marketCap,
    beta,
    sector,
    eps: input.schwab?.eps ?? null,
    peRatio: input.schwab?.peRatio ?? null,
    dividendAmount: input.schwab?.dividendAmount ?? null,
    dividendYield: input.schwab?.dividendYield ?? null,
    dividendFrequency: input.schwab?.dividendFrequency,
    dividendPayAmount: input.schwab?.dividendPayAmount ?? null,
    dividendPayDate: input.schwab?.dividendPayDate,
    dividendExDate: input.schwab?.dividendExDate,
    lastEarningsDate,
    nextEarningsDate,
    sourceStatus,
    fieldSources,
    sourceNotes: sourceNotes(fieldSources),
    dividendStatus: dividendStatus(input),
    warnings,
    scanContext: input.scanResult ? scanContext(input.scanResult) : undefined
  };
}

function valueWithSource<T>(
  primaryValue: T | undefined,
  primarySource: FundamentalFieldSources[keyof FundamentalFieldSources],
  fallbackValue: T | undefined,
  fallbackSource: FundamentalFieldSources[keyof FundamentalFieldSources],
  sources: FundamentalFieldSources,
  key: keyof FundamentalFieldSources
): T | undefined {
  if (primaryValue !== undefined && primaryValue !== null) {
    sources[key] = primarySource;
    return primaryValue;
  }
  if (fallbackValue !== undefined && fallbackValue !== null) {
    sources[key] = fallbackSource;
    return fallbackValue;
  }
  return undefined;
}

function sourceNotes(sources: FundamentalFieldSources): string[] {
  const labels: Array<[keyof FundamentalFieldSources, string]> = [
    ["beta", "Beta"],
    ["marketCap", "Market cap"],
    ["avgShareVolume", "Average share volume"],
    ["sector", "Sector"],
    ["nextEarningsDate", "Next earnings date"]
  ];
  return labels
    .filter(([key]) => sources[key] === "fmp")
    .map(([, label]) => label + " from FMP fallback.");
}

function dividendStatus(input: {
  schwab?: SchwabQuote;
}): FundamentalAnalysis["dividendStatus"] {
  const amount = input.schwab?.dividendAmount;
  const yieldValue = input.schwab?.dividendYield;
  const hasDividendDate = Boolean(input.schwab?.dividendPayDate || input.schwab?.dividendExDate);

  if ((amount !== undefined && amount > 0) || (yieldValue !== undefined && yieldValue > 0) || hasDividendDate) return "pays";
  if (input.schwab?.explicitZeroDividend) return "does_not_pay";
  return "unknown";
}

export function normalizeSchwabHistory(
  data: SchwabPriceHistoryResponse,
  options: { includeTime?: boolean; completedOnly?: boolean; now?: Date } = {}
): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const candle of data.candles ?? []) {
    const timestamp = new Date(candle.datetime).toISOString();
    const normalized = {
      date: options.includeTime ? timestamp : timestamp.slice(0, 10),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume)
    };
    if (!isValidCandle(normalized)) continue;
    if (options.completedOnly && !isCompletedDailyCandle(normalized.date, options.now ?? new Date())) continue;
    byDate.set(normalized.date, normalized);
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function isValidCandle(candle: Candle): boolean {
  return [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    && candle.open > 0
    && candle.high > 0
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close);
}

export function isCompletedDailyCandle(candleDate: string, now: Date): boolean {
  return isCompletedRegularSessionDate(candleDate, now);
}

export function normalizeSchwabCallOptions(data: SchwabOptionChainResponse, price: number): OptionContract[] {
  return flattenOptions(data.callExpDateMap).map((item) => normalizeOption(item, price, "call"));
}

export function normalizeSchwabPutOptions(data: SchwabOptionChainResponse, price: number): OptionContract[] {
  return flattenOptions(data.putExpDateMap).map((item) => normalizeOption(item, price, "put"));
}

function flattenOptions(map: SchwabOptionChainResponse["callExpDateMap"]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const strikes of Object.values(map ?? {})) {
    for (const contracts of Object.values(strikes)) {
      output.push(...contracts);
    }
  }
  return output;
}

function normalizeOption(item: Record<string, unknown>, price: number, optionType: "call" | "put"): OptionContract {
  const bid = numberValue(item.bid);
  const ask = numberValue(item.ask);
  const spreadPct = ask > 0 && bid > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 100;
  const openInterest = numberValue(item.openInterest);
  const volume = numberValue(item.totalVolume ?? item.volume);
  const strike = numberValue(item.strikePrice ?? item.strike);
  const expirationDate = String(item.expirationDate ?? "");
  const dte = daysToExpiration(expirationDate);
  return {
    symbol: String(item.symbol ?? ""),
    description: String(item.description ?? item.symbol ?? ""),
    expirationDate,
    strike,
    optionType,
    bid,
    ask,
    last: numberValue(item.last),
    volume,
    openInterest,
    delta: finiteNumber(item.delta),
    gamma: finiteNumber(item.gamma),
    impliedVolatility: finiteNumber(item.volatility ?? item.impliedVolatility),
    dte,
    spreadPct: Number(spreadPct.toFixed(2)),
    score: optionScore(spreadPct, volume, openInterest, strike, price)
  };
}

async function exchangeAuthorizationCode(code: string) {
  const response = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.schwabCallbackUrl
  });
  await saveTokens(response);
}

async function refreshAccessToken(tokens: SchwabTokens): Promise<SchwabTokens> {
  if (!tokens.refreshToken) throw new Error("Schwab refresh token is missing. Reconnect Schwab.");
  try {
    const response = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken
    });
    return saveTokens(response, tokens);
  } catch (error) {
    if (error instanceof SchwabTokenRequestError && (error.status === 401 || error.status === 403)) {
      await clearTokens();
      throw new Error("Schwab authorization expired or was rejected. Use Connect Schwab to reconnect.");
    }
    throw error;
  }
}

async function tokenRequest(params: Record<string, string>): Promise<SchwabTokenResponse> {
  const body = new URLSearchParams(params);
  const response = await fetchWithRetry((signal) => fetch(`${config.schwabAuthBaseUrl}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.schwabAppKey}:${config.schwabAppSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal
  }));
  if (!response.ok) {
    const text = await response.text();
    throw new SchwabTokenRequestError(response.status, response.statusText, text);
  }
  return response.json() as Promise<SchwabTokenResponse>;
}

async function schwabGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${config.schwabMarketDataBaseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetchWithRetry((signal) => fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    signal
  }));
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Schwab request failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function getAccessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) throw new Error("Schwab is not connected. Use Connect Schwab first.");
  if (new Date(tokens.accessTokenExpiresAt).getTime() > Date.now() + 60_000) return tokens.accessToken;
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(tokens).finally(() => {
      refreshPromise = null;
    });
  }
  return (await refreshPromise).accessToken;
}

async function readTokens(): Promise<SchwabTokens | undefined> {
  if (tokenCache !== null) return tokenCache;
  tokenCache = await getSetting<SchwabTokens | undefined>(TOKEN_SETTING, undefined);
  return tokenCache;
}

async function saveTokens(response: SchwabTokenResponse, previous?: SchwabTokens): Promise<SchwabTokens> {
  const expiresIn = response.expires_in ?? 1800;
  const next: SchwabTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previous?.refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refreshTokenIssuedAt: response.refresh_token ? new Date().toISOString() : previous?.refreshTokenIssuedAt
  };
  tokenCache = next;
  await setSetting(TOKEN_SETTING, next);
  return next;
}

async function clearTokens(): Promise<void> {
  tokenCache = undefined;
  await deleteSetting(TOKEN_SETTING);
}

export function __resetSchwabTokenCacheForTest(): void {
  tokenCache = null;
  refreshPromise = null;
}

function isStrikeNearPrice(item: OptionContract, price: number): boolean {
  if (item.optionType === "call") return item.strike >= price * 0.95 && item.strike <= price * 1.15;
  return item.strike >= price * 0.85 && item.strike <= price * 1.05;
}

function optionScore(spreadPct: number, volume: number, openInterest: number, strike: number, price: number): number {
  const spreadScore = Math.max(0, 40 - spreadPct * 2);
  const volumeScore = Math.min(25, volume / 20);
  const oiScore = Math.min(25, openInterest / 100);
  const moneynessScore = Math.max(0, 10 - Math.abs(strike / price - 1) * 100);
  return Number((spreadScore + volumeScore + oiScore + moneynessScore).toFixed(1));
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysToExpiration(value: string): number | undefined {
  const prefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!prefix) return undefined;
  const marketCloseUtcHour = isEasternDaylightTime(prefix) ? 20 : 21;
  const expiration = new Date(`${prefix}T${String(marketCloseUtcHour).padStart(2, "0")}:00:00.000Z`).getTime();
  const now = Date.now();
  if (!Number.isFinite(expiration)) return undefined;
  return Math.max(0, Math.ceil((expiration - now) / (24 * 60 * 60 * 1000)));
}

function isEasternDaylightTime(dateOnly: string): boolean {
  const noonUtc = new Date(`${dateOnly}T12:00:00.000Z`);
  if (!Number.isFinite(noonUtc.getTime())) return false;
  const offsetLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset"
  }).formatToParts(noonUtc).find((part) => part.type === "timeZoneName")?.value ?? "";
  return offsetLabel.includes("-4");
}

function createSchwabOAuthState(now = Date.now()): string {
  const bucket = Math.floor(now / (60 * 60 * 1000));
  return `${OAUTH_STATE_VERSION}.${bucket}.${stateSignature(bucket)}`;
}

function isValidSchwabOAuthState(value: string, now = Date.now()): boolean {
  const [version, bucketText, signature] = value.split(".");
  const bucket = Number(bucketText);
  if (version !== OAUTH_STATE_VERSION || !Number.isInteger(bucket) || !signature) return false;
  const currentBucket = Math.floor(now / (60 * 60 * 1000));
  if (bucket < currentBucket - OAUTH_STATE_WINDOW_HOURS || bucket > currentBucket) return false;
  return timingSafeEqualString(signature, stateSignature(bucket));
}

function stateSignature(bucket: number): string {
  return createHmac("sha256", config.schwabAppSecret)
    .update(config.schwabCallbackUrl)
    .update("|")
    .update(String(bucket))
    .digest("base64url");
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function hasExplicitZero(...values: unknown[]): boolean {
  return values.some((value) => {
    if (value === 0) return true;
    if (typeof value !== "string") return false;
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) && parsed === 0;
  });
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function dateStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value).toISOString().slice(0, 10);
  }
  return undefined;
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function scanContext(result: ScanResult): FundamentalAnalysis["scanContext"] {
  return {
    grade: result.grade,
    direction: result.setupDirection,
    score: result.score,
    maxScore: result.maxScore,
    longCallDecision: result.longCallDecision,
    dailySqueeze: result.indicators.squeezeState,
    weeklySqueeze: result.weeklyIndicators?.squeezeState,
    optionable: result.optionable,
    suggestedOptionCount: result.suggestedOptions.length
  };
}
