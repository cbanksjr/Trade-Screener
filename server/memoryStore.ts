import type { ScanMetadata } from "../shared/types";

type WatchlistRecord = { symbol: string; addedAt: string; payload: unknown };

const settings = new Map<string, unknown>();
let scanResults: Array<{ symbol: string }> = [];
let watchlist: WatchlistRecord[] = [];

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return settings.has(key) ? settings.get(key) as T : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  settings.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  settings.delete(key);
}

export async function replaceScanResults(results: Array<{ symbol: string }>): Promise<void> {
  scanResults = results;
}

export async function getCachedResults(): Promise<unknown[]> {
  return scanResults;
}

export async function upsertWatchlistEntry(symbol: string, payload: unknown, addedAt?: string): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  const existing = watchlist.find((entry) => entry.symbol === upperSymbol);
  const now = new Date().toISOString();
  watchlist = [
    { symbol: upperSymbol, addedAt: addedAt ?? existing?.addedAt ?? now, payload },
    ...watchlist.filter((entry) => entry.symbol !== upperSymbol)
  ];
}

export async function getWatchlistEntries(): Promise<WatchlistRecord[]> {
  return watchlist;
}

export async function removeWatchlistEntry(symbol: string): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  watchlist = watchlist.filter((entry) => entry.symbol !== upperSymbol);
}

export async function getScanMetadata(): Promise<ScanMetadata> {
  return getSetting<ScanMetadata>("scanMetadata", { scanStatus: "idle" });
}

export async function setScanMetadata(value: ScanMetadata): Promise<void> {
  await setSetting("scanMetadata", value);
}

export function resetMemoryStoreForTests(): void {
  settings.clear();
  scanResults = [];
  watchlist = [];
}
