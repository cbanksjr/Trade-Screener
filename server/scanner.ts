import type { Fundamentals, ScanResponse, ScanResult, Settings } from "../shared/types";
import { config } from "./config";
import { demoCandles, demoFundamental, demoOptions } from "./demoData";
import { defaultSettings, gradeSetup } from "./scoring";
import { fetchOptions, fetchHistory, fetchQuote, fetchQuotes, hasSchwabCredentials, hasSchwabTokens, type SchwabQuote } from "./schwab";
import { getFundamentals, getFundamentalSymbols, getSetting, saveScanResult, setSetting } from "./sqlite";

export function readSettings(): Settings {
  const stored = getSetting<Partial<Settings>>("settings", {});
  const importedUniverseCount = getFundamentalSymbols().length;
  return {
    scanMode: stored.scanMode ?? (importedUniverseCount > 0 ? defaultSettings.scanMode : "watchlist"),
    symbols: stored.symbols?.length ? stored.symbols.map((item) => item.toUpperCase()) : defaultSettings.symbols,
    minPrice: stored.minPrice ?? defaultSettings.minPrice,
    minBeta: stored.minBeta ?? defaultSettings.minBeta,
    minMarketCap: stored.minMarketCap ?? defaultSettings.minMarketCap,
    minAvgDollarVolume: stored.minAvgDollarVolume ?? defaultSettings.minAvgDollarVolume,
    brokerBaseUrl: config.schwabMarketDataBaseUrl,
    brokerCallbackUrl: config.schwabCallbackUrl,
    hasBrokerCredentials: hasSchwabCredentials(),
    useDemoDataWhenMissingApi: stored.useDemoDataWhenMissingApi ?? defaultSettings.useDemoDataWhenMissingApi,
    importedUniverseCount
  };
}

export function writeSettings(input: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...input };
  next.symbols = normalizeSymbols(next.symbols);
  next.scanMode = next.scanMode === "watchlist" ? "watchlist" : "universe";
  setSetting("settings", next);
  return readSettings();
}

export async function runScan(): Promise<ScanResponse> {
  const settings = readSettings();
  const fundamentals = getFundamentals();
  const results: ScanResult[] = [];
  const scanWarnings = new Set<string>();
  let usedLive = false;
  let usedDemo = false;
  const symbolsToScan = resolveScanSymbols(settings, fundamentals);
  const canUseLiveSchwab = hasSchwabCredentials() && hasSchwabTokens();
  const quoteMap = canUseLiveSchwab ? await loadQuoteMap(symbolsToScan, scanWarnings) : new Map<string, SchwabQuote>();

  if (settings.scanMode === "universe" && symbolsToScan.length === 0) {
    scanWarnings.add("No imported watchlist rows were found. Import a CSV with a Symbol or Ticker column, or switch to watchlist mode.");
  }

  for (const symbol of symbolsToScan) {
    const resultWarnings: string[] = [];
    let candlesSource: "schwab" | "demo" = "demo";
    let optionsSource: "schwab" | "demo" = "demo";
    let quote: SchwabQuote | undefined = quoteMap.get(symbol);
    const allowDemoFallback = settings.useDemoDataWhenMissingApi && (!canUseLiveSchwab || settings.scanMode === "watchlist");

    try {
      if (canUseLiveSchwab && !quote) {
        try {
          quote = await fetchQuote(symbol);
        } catch (error) {
          resultWarnings.push(readError(error, "Schwab quote request failed."));
        }
      }

      if (canUseLiveSchwab && settings.scanMode === "universe" && !quote) {
        scanWarnings.add(`${symbol}: Schwab did not return a quote; skipped.`);
        continue;
      }

      if (quote && quote.price <= settings.minPrice) {
        scanWarnings.add(`${symbol}: skipped because Schwab quote price $${quote.price.toFixed(2)} is below $${settings.minPrice}.`);
        continue;
      }

      if (quote?.avgDollarVolume !== undefined && quote.avgDollarVolume < settings.minAvgDollarVolume) {
        scanWarnings.add(`${symbol}: skipped because Schwab average dollar volume is below ${formatMoney(settings.minAvgDollarVolume)}.`);
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
        fundamentals: mergeFundamentals(fundamentals.get(symbol) ?? demoFundamental(symbol), symbol, quote),
        optionable,
        options
      });
      result.dataSource = candlesSource === "schwab" && optionsSource === "schwab" ? "schwab" : candlesSource === "demo" && optionsSource === "demo" ? "demo" : "mixed";
      result.warnings.push(...resultWarnings);
      resultWarnings.forEach((warning) => scanWarnings.add(`${symbol}: ${warning}`));
      if (shouldIncludeResult(result, settings)) results.push(result);
      saveScanResult(symbol, result);
      await throttleIfLive();
    } catch (error) {
      if (canUseLiveSchwab && settings.scanMode === "universe") {
        scanWarnings.add(`${symbol}: ${error instanceof Error ? error.message : "Scan failed."}`);
        continue;
      }
      const candles = demoCandles(symbol);
      const price = candles[candles.length - 1].close;
      const fallback = gradeSetup({
        symbol,
        candles,
        fundamentals: fundamentals.get(symbol) ?? demoFundamental(symbol),
        optionable: settings.useDemoDataWhenMissingApi,
        options: settings.useDemoDataWhenMissingApi ? demoOptions(symbol, price) : []
      });
      fallback.dataSource = "demo";
      fallback.warnings.push(error instanceof Error ? error.message : "Scan failed.");
      fallback.warnings.forEach((warning) => scanWarnings.add(`${symbol}: ${warning}`));
      if (shouldIncludeResult(fallback, settings)) results.push(fallback);
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

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.flatMap((item) => item.split(/[,\s]+/)).map((item) => item.trim().toUpperCase()).filter(Boolean))];
}

function resolveScanSymbols(settings: Settings, fundamentals: ReturnType<typeof getFundamentals>): string[] {
  if (settings.scanMode === "watchlist") return settings.symbols;

  return [...fundamentals.values()].map((item) => item.symbol);
}

function shouldIncludeResult(result: ScanResult, settings: Settings): boolean {
  if (settings.scanMode === "watchlist") return true;
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

function mergeFundamentals(
  imported: Fundamentals | undefined,
  symbol: string,
  quote?: SchwabQuote
): Fundamentals {
  return {
    symbol,
    beta: imported?.beta,
    marketCap: imported?.marketCap,
    avgDollarVolume20d: quote?.avgDollarVolume ?? imported?.avgDollarVolume20d
  };
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
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
