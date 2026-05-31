import type { LowerTimeframeConfluence, ScanResponse, ScanResult, Settings } from "../shared/types";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { defaultSettings, gradeSetup } from "./scoring";
import { fetchOptions, fetchHistory, fetchIntradayHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getSetting, saveScanResult, setSetting } from "./sqlite";
import { buildLowerTimeframeConfluence } from "./timeframes";
import { getDefaultUniverseStatus, getDefaultUniverseSymbols } from "./universe";

export function readSettings(): Settings {
  const stored = getSetting<Partial<Settings>>("settings", {});
  const defaultUniverse = getDefaultUniverseStatus();
  return {
    minPrice: stored.minPrice ?? defaultSettings.minPrice,
    minBeta: stored.minBeta ?? defaultSettings.minBeta,
    minMarketCap: stored.minMarketCap ?? defaultSettings.minMarketCap,
    minAvgDollarVolume: stored.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume,
    brokerBaseUrl: config.schwabMarketDataBaseUrl,
    brokerCallbackUrl: config.schwabCallbackUrl,
    hasBrokerCredentials: hasSchwabCredentials(),
    useDemoDataWhenMissingApi: stored.useDemoDataWhenMissingApi ?? defaultSettings.useDemoDataWhenMissingApi,
    defaultUniverseName: defaultUniverse.name,
    defaultUniverseCount: defaultUniverse.count,
    defaultUniverseLastCheckedAt: defaultUniverse.lastCheckedAt
  };
}

export function writeSettings(input: Partial<Settings>): Settings {
  const current = readSettings();
  const next: Settings = {
    ...current,
    minPrice: input.minPrice ?? current.minPrice,
    minBeta: input.minBeta ?? current.minBeta,
    minMarketCap: input.minMarketCap ?? current.minMarketCap,
    minAvgDollarVolume: input.minAvgDollarVolume ?? current.minAvgDollarVolume,
    useDemoDataWhenMissingApi: input.useDemoDataWhenMissingApi ?? current.useDemoDataWhenMissingApi
  };
  setSetting("settings", next);
  return readSettings();
}

export async function runScan(): Promise<ScanResponse> {
  const settings = readSettings();
  const results: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  const symbolsToScan = resolveScanSymbols();
  const canUseLiveSchwab = hasSchwabCredentials() && hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();

  if (!canUseLiveSchwab) {
    scanWarnings.add("Automatic screening needs Schwab connected so it can scan the full S&P 500 + Nasdaq 100 universe with live market data.");
  }

  for (const symbol of symbolsToScan) {
    const resultWarnings: string[] = [];
    let candlesSource: "schwab" | "demo" = "demo";
    let optionsSource: "schwab" | "demo" = "demo";
    let quote: SchwabQuote | undefined = quoteMap.get(symbol);
    const allowDemoFallback = settings.useDemoDataWhenMissingApi && (!canUseLiveSchwab || Boolean(demoFundamental(symbol)));

    try {
      if (canUseLiveSchwab && !quote) {
        try {
          quote = await fetchQuote(symbol);
        } catch (error) {
          resultWarnings.push(readError(error, "Schwab quote request failed."));
        }
      }

      if (canUseLiveSchwab && !quote) {
        scanWarnings.add(symbol + ": Schwab did not return a quote; skipped.");
        continue;
      }

      if (quote && quote.price <= settings.minPrice) {
        scanWarnings.add(symbol + ": skipped because Schwab quote price $" + quote.price.toFixed(2) + " is below $" + settings.minPrice + ".");
        continue;
      }

      if (quote?.beta !== undefined && quote.beta < settings.minBeta) {
        scanWarnings.add(symbol + ": skipped because Schwab beta is below " + settings.minBeta + ".");
        continue;
      }
      if (quote?.marketCap !== undefined && quote.marketCap < settings.minMarketCap) {
        scanWarnings.add(symbol + ": skipped because Schwab market cap is below " + formatMoney(settings.minMarketCap) + ".");
        continue;
      }

      if (quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
        scanWarnings.add(symbol + ": skipped because Schwab average dollar volume is below " + formatMoney(settings.minAvgDollarVolume) + ".");
        continue;
      }

      let candles = canUseLiveSchwab ? await fetchHistory(symbol) : [];
      if (candles.length >= 50) {
        candlesSource = "schwab";
        usedLive = true;
      }
      if (candles.length < 50 && allowDemoFallback) {
        if (canUseLiveSchwab) resultWarnings.push("Schwab returned fewer than 50 historical candles; demo candles were used.");
        candles = demoCandles(symbol);
        candlesSource = "demo";
        usedDemo = true;
      }
      if (candles.length < 50) throw new Error("Not enough candle history.");

      const price = quote?.price ?? candles[candles.length - 1].close;
      if (quote) {
        candles[candles.length - 1] = { ...candles[candles.length - 1], close: quote.price };
      }

      const lowerTimeframeWarnings: string[] = [];
      const lowerTimeframes = canUseLiveSchwab
        ? await loadLowerTimeframeConfluence(symbol, lowerTimeframeWarnings)
        : undefined;
      resultWarnings.push(...lowerTimeframeWarnings);

      let options: Awaited<ReturnType<typeof fetchOptions>> = [];
      if (canUseLiveSchwab) {
        try {
          options = await fetchOptions(symbol, price);
          if (options.length) {
            optionsSource = "schwab";
            usedLive = true;
          }
        } catch (error) {
          resultWarnings.push(readError(error, "Schwab options request failed."));
        }
      }

      if (!options.length && allowDemoFallback) {
        if (canUseLiveSchwab) resultWarnings.push("No live Schwab option contracts met the filters; demo contracts were used.");
        options = demoOptions(symbol, price);
        optionsSource = "demo";
        usedDemo = true;
      }
      const optionable = options.length > 0;

      const result = gradeSetup({
        symbol,
        companyName: quote?.companyName,
        candles,
        fundamentals: mergeFundamentals(symbol, quote),
        optionable,
        options,
        lowerTimeframes
      });
      result.dataSource = candlesSource === "schwab" && optionsSource === "schwab" ? "schwab" : candlesSource === "demo" && optionsSource === "demo" ? "demo" : "mixed";
      result.warnings.push(...resultWarnings);
      resultWarnings.forEach((warning) => scanWarnings.add(symbol + ": " + warning));
      if (shouldIncludeResult(result)) results.push(result);
      saveScanResult(symbol, result);
      await throttleIfLive();
    } catch (error) {
      if (canUseLiveSchwab) {
        scanWarnings.add(symbol + ": " + (error instanceof Error ? error.message : "Scan failed."));
        continue;
      }
      if (!allowDemoFallback || !demoFundamental(symbol)) continue;
      const candles = demoCandles(symbol);
      const price = candles[candles.length - 1].close;
      const fallback = gradeSetup({
        symbol,
        candles,
        fundamentals: demoFundamental(symbol),
        optionable: settings.useDemoDataWhenMissingApi,
        options: settings.useDemoDataWhenMissingApi ? demoOptions(symbol, price) : []
      });
      fallback.dataSource = "demo";
      fallback.warnings.push(error instanceof Error ? error.message : "Scan failed.");
      fallback.warnings.forEach((warning) => scanWarnings.add(symbol + ": " + warning));
      if (shouldIncludeResult(fallback)) results.push(fallback);
      saveScanResult(symbol, fallback);
      usedDemo = true;
    }
  }

  return {
    mode: usedLive && usedDemo ? "mixed" : usedLive ? "live" : "demo",
    results: results.sort((a, b) => b.score / b.maxScore - a.score / a.maxScore),
    settings,
    warnings: [...scanWarnings].filter(shouldShowWarning)
  };
}

export function resolveScanSymbols(): string[] {
  return getDefaultUniverseSymbols();
}

function shouldIncludeResult(result: ScanResult): boolean {
  return result.passesUniverse && result.grade !== "D" && result.grade !== "F";
}

function readError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function loadQuoteMap(symbols: string[], warnings: Set<string>): Promise<Map<string, SchwabQuote>> {
  try {
    return await fetchQuotes(symbols);
  } catch (error) {
    warnings.add(readError(error, "Schwab batch quote request failed."));
    return new Map();
  }
}

async function loadLowerTimeframeConfluence(symbol: string, warnings: string[]): Promise<LowerTimeframeConfluence | undefined> {
  try {
    const intradayCandles = await fetchIntradayHistory(symbol);
    const confluence = buildLowerTimeframeConfluence(intradayCandles);
    if (confluence.oneHour.bias === "unavailable") warnings.push("1h confluence unavailable: " + confluence.oneHour.detail);
    if (confluence.fourHour.bias === "unavailable") warnings.push("4h confluence unavailable: " + confluence.fourHour.detail);
    return confluence;
  } catch (error) {
    warnings.push(readError(error, "Schwab intraday history request failed."));
    return undefined;
  }
}

function mergeFundamentals(symbol: string, quote?: SchwabQuote) {
  const demo = demoFundamental(symbol);
  return {
    symbol,
    beta: quote?.beta ?? demo?.beta,
    marketCap: quote?.marketCap ?? demo?.marketCap,
    avgDollarVolume20d: quote?.avgDollarVolume ?? demo?.avgDollarVolume20d
  };
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}

async function throttleIfLive() {
  if (!hasSchwabCredentials() || !hasSchwabTokens()) return;
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function shouldShowWarning(warning: string): boolean {
  const routineSkips = [
    "Schwab did not return a quote; skipped.",
    "skipped because Schwab quote price",
    "skipped because Schwab average dollar volume"
  ];
  return !routineSkips.some((message) => warning.includes(message));
}
