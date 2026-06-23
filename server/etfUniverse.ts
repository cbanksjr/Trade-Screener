import { config } from "./config";

export const defaultEtfSymbols = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "SMH",
  "XLK",
  "XLF",
  "XLV",
  "XLE",
  "XLY",
  "XLI",
  "XLC",
  "XLP",
  "XLU",
  "XLB",
  "XLRE"
];

export function resolveEtfSymbols(input?: string[] | string): string[] {
  if (Array.isArray(input)) return normalizeEtfSymbols(input);
  if (typeof input === "string" && input.trim()) return parseEtfSymbols(input);
  if (config.etfSymbols.trim()) return parseEtfSymbols(config.etfSymbols);
  return defaultEtfSymbols;
}

export function parseEtfSymbols(value: string): string[] {
  return normalizeEtfSymbols(value.split(","));
}

export function normalizeEtfSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(isValidEtfSymbol))].sort();
}

export function isEtfSymbol(symbol: string, etfSymbols: Iterable<string>): boolean {
  const wanted = new Set([...etfSymbols].map((item) => item.trim().toUpperCase()));
  return wanted.has(symbol.trim().toUpperCase());
}

function isValidEtfSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z.]{0,5}$/.test(symbol);
}
