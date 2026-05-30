import { config } from "./config";
import type { Candle, OptionContract, TradierStatus } from "../shared/types";

export type TradierQuote = {
  symbol: string;
  price: number;
  companyName?: string;
  volume?: number;
  averageVolume?: number;
  rootSymbols?: string[];
  avgDollarVolume?: number;
};

type TradierHistoryResponse = {
  history?: { day?: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> };
};

type TradierQuotesResponse = {
  quotes?: {
    quote?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
};

type TradierOptionsResponse = {
  options?: {
    option?: Array<Record<string, unknown>> | Record<string, unknown>;
  };
};

type TradierExpirationsResponse = {
  expirations?: { date?: string[] | string };
};

export function hasTradierCredentials(): boolean {
  return Boolean(config.tradierToken);
}

export async function getTradierStatus(sampleSymbol = "AAPL"): Promise<TradierStatus> {
  const base = {
    configured: hasTradierCredentials(),
    baseUrl: config.tradierBaseUrl,
    checkedAt: new Date().toISOString(),
    sampleSymbol
  };

  if (!hasTradierCredentials()) {
    return {
      ...base,
      ok: false,
      message: "TRADIER_TOKEN is not configured. The app will use demo data fallback when enabled."
    };
  }

  try {
    const quote = await fetchQuote(sampleSymbol);
    return {
      ...base,
      ok: true,
      samplePrice: quote?.price,
      message: quote ? `Connected. Latest ${sampleSymbol} quote loaded.` : "Connected, but no sample quote was returned."
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      message: error instanceof Error ? error.message : "Tradier status check failed."
    };
  }
}

export async function fetchQuote(symbol: string): Promise<TradierQuote | undefined> {
  return (await fetchQuotes([symbol])).get(symbol.toUpperCase());
}

export async function fetchQuotes(symbols: string[]): Promise<Map<string, TradierQuote>> {
  const output = new Map<string, TradierQuote>();
  const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  for (const batch of chunks(uniqueSymbols, 80)) {
    const data = await tradierGet<TradierQuotesResponse>("/markets/quotes", { symbols: batch.join(","), greeks: "false" });
    for (const quote of normalizeQuotes(data)) {
      output.set(quote.symbol, quote);
    }
  }
  return output;
}

function normalizeQuotes(data: TradierQuotesResponse): TradierQuote[] {
  const raw = data.quotes?.quote;
  const quotes = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return quotes.flatMap((quote) => {
    const symbol = String(quote.symbol ?? "").toUpperCase();
    const price = firstNumber(quote.last, quote.close, quote.prevclose);
    if (!symbol || !price) return [];
    const averageVolume = optionalNumber(quote.average_volume);
    return [{
      symbol,
      price,
      companyName: typeof quote.description === "string" ? quote.description : undefined,
      volume: optionalNumber(quote.volume),
      averageVolume,
      rootSymbols: typeof quote.root_symbols === "string" ? quote.root_symbols.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
      avgDollarVolume: averageVolume ? averageVolume * price : undefined
    }];
  });
}

export async function fetchHistory(symbol: string): Promise<Candle[]> {
  const start = new Date();
  start.setDate(start.getDate() - 300);
  const data = await tradierGet<TradierHistoryResponse>("/markets/history", {
    symbol,
    interval: "daily",
    start: start.toISOString().slice(0, 10)
  });
  return (data.history?.day ?? []).map((day) => ({
    date: day.date,
    open: Number(day.open),
    high: Number(day.high),
    low: Number(day.low),
    close: Number(day.close),
    volume: Number(day.volume)
  })).filter((day) => Number.isFinite(day.close) && Number.isFinite(day.volume));
}

export async function fetchCallOptions(symbol: string, price: number): Promise<OptionContract[]> {
  const expirations = await tradierGet<TradierExpirationsResponse>("/markets/options/expirations", {
    symbol,
    includeAllRoots: "true",
    strikes: "false"
  });
  const dates = Array.isArray(expirations.expirations?.date)
    ? expirations.expirations.date
    : expirations.expirations?.date ? [expirations.expirations.date] : [];
  const preferredExpirations = dates
    .filter((date) => daysUntil(date) >= 30 && daysUntil(date) <= 180)
    .slice(0, 6);
  const expirationsToScan = preferredExpirations.length ? preferredExpirations : dates.slice(0, 2);
  if (!expirationsToScan.length) return [];

  const chains = await Promise.all(expirationsToScan.map(async (expiration) => {
    const data = await tradierGet<TradierOptionsResponse>("/markets/options/chains", { symbol, expiration, greeks: "true" });
    const raw = data.options?.option;
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  }));

  return chains.flat()
    .filter((item) => item.option_type === "call")
    .map((item) => normalizeOption(item, price))
    .filter((item) => item.bid > 0 && item.ask > 0 && item.strike >= price * 0.95 && item.strike <= price * 1.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

async function tradierGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  if (!config.tradierToken) throw new Error("TRADIER_TOKEN is missing.");
  const url = new URL(`${config.tradierBaseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.tradierToken}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tradier request failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

function normalizeOption(item: Record<string, unknown>, price: number): OptionContract {
  const bid = numberValue(item.bid);
  const ask = numberValue(item.ask);
  const spreadPct = ask > 0 && bid > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 100;
  const openInterest = numberValue(item.open_interest);
  const volume = numberValue(item.volume);
  return {
    symbol: String(item.symbol ?? ""),
    description: String(item.description ?? item.symbol ?? ""),
    expirationDate: String(item.expiration_date ?? ""),
    strike: numberValue(item.strike),
    optionType: "call",
    bid,
    ask,
    last: numberValue(item.last),
    volume,
    openInterest,
    delta: typeof item.greeks === "object" && item.greeks !== null ? numberValue((item.greeks as Record<string, unknown>).delta) : undefined,
    spreadPct: Number(spreadPct.toFixed(2)),
    score: optionScore(spreadPct, volume, openInterest, numberValue(item.strike), price)
  };
}

function optionScore(spreadPct: number, volume: number, openInterest: number, strike: number, price: number): number {
  const spreadScore = Math.max(0, 40 - spreadPct * 2);
  const volumeScore = Math.min(25, volume / 20);
  const oiScore = Math.min(25, openInterest / 100);
  const moneynessScore = Math.max(0, 10 - Math.abs(strike / price - 1) * 100);
  return Number((spreadScore + volumeScore + oiScore + moneynessScore).toFixed(1));
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function daysUntil(dateString: string): number {
  return Math.round((new Date(dateString).getTime() - Date.now()) / 86_400_000);
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}
