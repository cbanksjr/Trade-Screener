import { Buffer } from "node:buffer";
import { config } from "./config";
import { fetchAlphaVantageEarningsCalendar, fetchAlphaVantageOverview, type AlphaVantageOverview } from "./alphaVantage";
import { getSetting, setSetting } from "./sqlite";
import type { BrokerStatus, Candle, FundamentalAnalysis, OptionContract, ScanResult } from "../shared/types";

export type SchwabQuote = {
  symbol: string;
  price: number;
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
let tokenCache: SchwabTokens | undefined | null = null;

export function hasSchwabCredentials(): boolean {
  return Boolean(config.schwabAppKey && config.schwabAppSecret && config.schwabCallbackUrl);
}

export function hasSchwabTokens(): boolean {
  return Boolean(readTokens()?.accessToken);
}

export function getSchwabLoginUrl(): string {
  if (!hasSchwabCredentials()) throw new Error("SCHWAB_APP_KEY, SCHWAB_APP_SECRET, and SCHWAB_CALLBACK_URL are required.");
  const url = new URL(`${config.schwabAuthBaseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.schwabAppKey);
  url.searchParams.set("redirect_uri", config.schwabCallbackUrl);
  return url.toString();
}

export async function handleSchwabCallback(code: string): Promise<BrokerStatus> {
  if (!code) throw new Error("Schwab callback did not include an authorization code.");
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

  const stored = readTokens();
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
  const providerWarnings: string[] = [];

  try {
    quote = await fetchQuote(upperSymbol);
  } catch (error) {
    providerWarnings.push(error instanceof Error ? error.message : "Schwab fundamentals request failed.");
  }

  if (!quote) providerWarnings.push("Schwab did not return fundamentals for " + upperSymbol + ".");

  const alphaVantage = await fetchAlphaVantageOverview(upperSymbol);
  if (alphaVantage.warning) providerWarnings.push(alphaVantage.warning);
  const earningsCalendar = await fetchAlphaVantageEarningsCalendar(upperSymbol);
  if (earningsCalendar.warning) providerWarnings.push(earningsCalendar.warning);

  return mergeFundamentalAnalysis({
    symbol: upperSymbol,
    schwab: quote,
    alphaVantage: alphaVantage.overview,
    nextEarningsDate: earningsCalendar.nextEarningsDate,
    scanResult,
    providerWarnings
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
  return fetchDailyHistory(symbol, 370);
}

export async function fetchChartHistory(symbol: string): Promise<Candle[]> {
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
  return normalizeSchwabHistory(data);
}

export async function fetchIntradayHistory(symbol: string): Promise<Candle[]> {
  const endDate = Date.now();
  const startDate = endDate - 90 * 24 * 60 * 60 * 1000;
  const data = await schwabGet<SchwabPriceHistoryResponse>("/pricehistory", {
    symbol,
    startDate,
    endDate,
    frequencyType: "minute",
    frequency: "30",
    needExtendedHoursData: "false",
    needPreviousClose: "false"
  });
  return normalizeSchwabHistory(data, { includeTime: true });
}

export async function fetchOptions(symbol: string, price: number): Promise<OptionContract[]> {
  const [calls, puts] = await Promise.all([
    fetchDirectionalOptions(symbol, price, "CALL"),
    fetchDirectionalOptions(symbol, price, "PUT")
  ]);
  return [...calls, ...puts];
}

export async function fetchCallOptions(symbol: string, price: number): Promise<OptionContract[]> {
  return fetchDirectionalOptions(symbol, price, "CALL");
}

async function fetchDirectionalOptions(symbol: string, price: number, contractType: "CALL" | "PUT"): Promise<OptionContract[]> {
  const fromDate = dateOffset(30);
  const toDate = dateOffset(180);
  const data = await schwabGet<SchwabOptionChainResponse>("/chains", {
    symbol,
    contractType,
    strategy: "SINGLE",
    includeUnderlyingQuote: "false",
    fromDate,
    toDate
  });
  const options = contractType === "CALL" ? normalizeSchwabCallOptions(data, price) : normalizeSchwabPutOptions(data, price);
  return options
    .filter((item) => item.bid > 0 && item.ask > 0 && isStrikeNearPrice(item, price))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function normalizeSchwabQuotes(data: SchwabQuotePayload): SchwabQuote[] {
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
      companyName: stringValue(reference.description),
      volume: firstNumber(quote.totalVolume, quote.volume),
      averageVolume,
      rootSymbols: stringValue(reference.optionRoot)?.split(",").map((item) => item.trim()).filter(Boolean),
      avgDollarVolume: averageVolume ? averageVolume * price : undefined,
      beta: firstNumber(fundamental.beta, fundamental.betaCoefficient),
      marketCap: firstNumber(fundamental.marketCap, fundamental.marketCapitalization, fundamental.marketCapFloat),
      eps: firstNumber(fundamental.eps, fundamental.epsTTM, fundamental.epsTrailingTwelveMonths),
      peRatio: firstNumber(fundamental.peRatio, fundamental.peRatioTTM, fundamental.pERatio),
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
  return mergeFundamentalAnalysis({ symbol: quote.symbol, schwab: quote, scanResult, providerWarnings: [] });
}

export function mergeFundamentalAnalysis(input: {
  symbol: string;
  schwab?: SchwabQuote;
  alphaVantage?: AlphaVantageOverview;
  nextEarningsDate?: string;
  scanResult?: ScanResult;
  providerWarnings: string[];
}): FundamentalAnalysis {
  const sources: Record<string, string> = {};
  const missingReasons: Record<string, string> = {};
  const providerWarnings = [...new Set(input.providerWarnings.filter(Boolean))];
  const sourceStatus = input.schwab || input.alphaVantage ? "live" : "unavailable";
  const symbol = input.schwab?.symbol ?? input.alphaVantage?.symbol ?? input.symbol;
  const companyName = pickField("companyName", [
    ["Schwab", input.schwab?.companyName],
    ["Alpha Vantage", input.alphaVantage?.companyName],
    ["Cached scan", input.scanResult?.companyName]
  ], sources);

  const analysis: FundamentalAnalysis = {
    symbol,
    companyName,
    price: pickField("price", [["Schwab", input.schwab?.price], ["Cached scan", input.scanResult?.price]], sources) ?? null,
    volume: pickField("volume", [["Schwab", input.schwab?.volume]], sources) ?? null,
    averageVolume: pickField("averageVolume", [["Schwab", input.schwab?.averageVolume]], sources) ?? null,
    avgDollarVolume: pickField("avgDollarVolume", [["Schwab", input.schwab?.avgDollarVolume], ["Cached scan", input.scanResult?.avgDollarVolume20d]], sources) ?? null,
    marketCap: pickField("marketCap", [["Schwab", input.schwab?.marketCap], ["Alpha Vantage", input.alphaVantage?.marketCap], ["Cached scan", input.scanResult?.marketCap ?? undefined]], sources) ?? null,
    beta: pickField("beta", [["Schwab", input.schwab?.beta], ["Alpha Vantage", input.alphaVantage?.beta], ["Cached scan", input.scanResult?.beta ?? undefined]], sources) ?? null,
    eps: pickField("eps", [["Schwab", input.schwab?.eps], ["Alpha Vantage", input.alphaVantage?.eps]], sources) ?? null,
    peRatio: pickField("peRatio", [["Schwab", input.schwab?.peRatio], ["Alpha Vantage", input.alphaVantage?.peRatio]], sources) ?? null,
    dividendAmount: pickField("dividendAmount", [["Schwab", input.schwab?.dividendAmount], ["Alpha Vantage", input.alphaVantage?.dividendAmount]], sources) ?? null,
    dividendYield: pickField("dividendYield", [["Schwab", input.schwab?.dividendYield], ["Alpha Vantage", input.alphaVantage?.dividendYield]], sources) ?? null,
    dividendFrequency: pickField("dividendFrequency", [["Schwab", input.schwab?.dividendFrequency]], sources),
    dividendPayAmount: pickField("dividendPayAmount", [["Schwab", input.schwab?.dividendPayAmount]], sources) ?? null,
    dividendPayDate: pickField("dividendPayDate", [["Schwab", input.schwab?.dividendPayDate], ["Alpha Vantage", input.alphaVantage?.dividendPayDate]], sources),
    dividendExDate: pickField("dividendExDate", [["Schwab", input.schwab?.dividendExDate], ["Alpha Vantage", input.alphaVantage?.dividendExDate]], sources),
    lastEarningsDate: pickField("lastEarningsDate", [["Schwab", input.schwab?.lastEarningsDate]], sources),
    nextEarningsDate: pickField("nextEarningsDate", [["Alpha Vantage", input.nextEarningsDate]], sources),
    sourceStatus,
    dividendStatus: dividendStatus(input),
    warnings: providerWarnings,
    sources,
    missingReasons,
    providerWarnings,
    scanContext: input.scanResult ? scanContext(input.scanResult) : undefined
  };

  addMissingReasons(analysis, input);
  return analysis;
}

function pickField<T>(field: string, candidates: Array<[string, T | null | undefined]>, sources: Record<string, string>): T | undefined {
  for (const [source, value] of candidates) {
    if (value !== null && value !== undefined && value !== "") {
      sources[field] = source;
      return value;
    }
  }
  return undefined;
}

function addMissingReasons(analysis: FundamentalAnalysis, input: {
  schwab?: SchwabQuote;
  alphaVantage?: AlphaVantageOverview;
  scanResult?: ScanResult;
  providerWarnings: string[];
}) {
  const schwabAvailable = Boolean(input.schwab);
  const alphaAvailable = Boolean(input.alphaVantage);
  const reason = missingReason(schwabAvailable, alphaAvailable, input.providerWarnings);

  for (const field of [
    "price",
    "volume",
    "averageVolume",
    "avgDollarVolume",
    "marketCap",
    "beta",
    "eps",
    "peRatio",
    "dividendAmount",
    "dividendYield",
    "dividendFrequency",
    "dividendPayAmount",
    "dividendPayDate",
    "dividendExDate",
    "lastEarningsDate",
    "nextEarningsDate"
  ]) {
    if (analysis.sources[field]) continue;
    analysis.missingReasons[field] = dividendField(field)
      ? "No dividend or earnings value was reported by the connected fundamentals sources."
      : reason;
  }
}

function dividendStatus(input: {
  schwab?: SchwabQuote;
  alphaVantage?: AlphaVantageOverview;
}): FundamentalAnalysis["dividendStatus"] {
  const amount = input.schwab?.dividendAmount ?? input.alphaVantage?.dividendAmount;
  const yieldValue = input.schwab?.dividendYield ?? input.alphaVantage?.dividendYield;
  const hasDividendDate = Boolean(input.schwab?.dividendPayDate || input.alphaVantage?.dividendPayDate || input.schwab?.dividendExDate || input.alphaVantage?.dividendExDate);

  if ((amount !== undefined && amount > 0) || (yieldValue !== undefined && yieldValue > 0) || hasDividendDate) return "pays";
  if (input.schwab?.explicitZeroDividend || input.alphaVantage?.explicitZeroDividend) return "does_not_pay";
  return "unknown";
}

function missingReason(schwabAvailable: boolean, alphaAvailable: boolean, warnings: string[]): string {
  if (!schwabAvailable && !alphaAvailable) {
    return warnings.length ? "Neither Schwab nor Alpha Vantage returned this value." : "No fundamentals source returned this value.";
  }
  if (!alphaAvailable && warnings.some((warning) => warning.includes("Alpha Vantage API key is missing"))) {
    return "Schwab did not provide this value, and Alpha Vantage is not configured.";
  }
  if (!alphaAvailable && warnings.some((warning) => warning.includes("Alpha Vantage"))) {
    return "Schwab did not provide this value, and Alpha Vantage could not fill it.";
  }
  return "Not provided by Schwab or Alpha Vantage for this symbol.";
}

function dividendField(field: string): boolean {
  return field.startsWith("dividend") || field === "lastEarningsDate" || field === "nextEarningsDate";
}

export function normalizeSchwabHistory(data: SchwabPriceHistoryResponse, options: { includeTime?: boolean } = {}): Candle[] {
  return (data.candles ?? []).map((candle) => {
    const timestamp = new Date(candle.datetime).toISOString();
    return {
      date: options.includeTime ? timestamp : timestamp.slice(0, 10),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume)
    };
  }).filter((day) => Number.isFinite(day.close) && Number.isFinite(day.volume));
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
  return {
    symbol: String(item.symbol ?? ""),
    description: String(item.description ?? item.symbol ?? ""),
    expirationDate: String(item.expirationDate ?? ""),
    strike,
    optionType,
    bid,
    ask,
    last: numberValue(item.last),
    volume,
    openInterest,
    delta: finiteNumber(item.delta),
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
  saveTokens(response);
}

async function refreshAccessToken(tokens: SchwabTokens): Promise<SchwabTokens> {
  if (!tokens.refreshToken) throw new Error("Schwab refresh token is missing. Reconnect Schwab.");
  const response = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken
  });
  return saveTokens(response, tokens);
}

async function tokenRequest(params: Record<string, string>): Promise<SchwabTokenResponse> {
  const body = new URLSearchParams(params);
  const response = await fetch(`${config.schwabAuthBaseUrl}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.schwabAppKey}:${config.schwabAppSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Schwab token request failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<SchwabTokenResponse>;
}

async function schwabGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${config.schwabMarketDataBaseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Schwab request failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function getAccessToken(): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new Error("Schwab is not connected. Use Connect Schwab first.");
  if (new Date(tokens.accessTokenExpiresAt).getTime() > Date.now() + 60_000) return tokens.accessToken;
  return (await refreshAccessToken(tokens)).accessToken;
}

function readTokens(): SchwabTokens | undefined {
  if (tokenCache !== null) return tokenCache;
  tokenCache = getSetting<SchwabTokens | undefined>(TOKEN_SETTING, undefined);
  return tokenCache;
}

function saveTokens(response: SchwabTokenResponse, previous?: SchwabTokens): SchwabTokens {
  const expiresIn = response.expires_in ?? 1800;
  const next: SchwabTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previous?.refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refreshTokenIssuedAt: response.refresh_token ? new Date().toISOString() : previous?.refreshTokenIssuedAt
  };
  tokenCache = next;
  setSetting(TOKEN_SETTING, next);
  return next;
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

function unavailableFundamentals(symbol: string, scanResult: ScanResult | undefined, warning: string): FundamentalAnalysis {
  const analysis = mergeFundamentalAnalysis({
    symbol,
    scanResult,
    providerWarnings: [warning]
  });
  analysis.warnings = [warning];
  return analysis;
}

function scanContext(result: ScanResult): FundamentalAnalysis["scanContext"] {
  return {
    grade: result.grade,
    direction: result.setupDirection,
    score: result.score,
    maxScore: result.maxScore,
    dailySqueeze: result.indicators.squeezeState,
    weeklySqueeze: result.weeklyIndicators?.squeezeState,
    oneHourSqueeze: result.lowerTimeframes?.oneHour.squeezeState,
    fourHourSqueeze: result.lowerTimeframes?.fourHour.squeezeState,
    optionable: result.optionable,
    suggestedOptionCount: result.suggestedOptions.length
  };
}
