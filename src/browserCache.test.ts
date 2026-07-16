import { describe, expect, it } from "vitest";
import type { LocalSessionSnapshot } from "../shared/types";
import { clearBrowserSession, loadBrowserSession, saveBrowserSession } from "./browserCache";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const snapshot: LocalSessionSnapshot = {
  mode: "live",
  results: [],
  settings: {
    minPrice: 20,
    minBeta: 0.8,
    minMarketCap: 2_000_000_000,
    minAvgDollarVolume: 300_000_000,
    brokerBaseUrl: "https://api.schwabapi.com/marketdata/v1",
    brokerCallbackUrl: "https://127.0.0.1:4173/api/schwab/callback",
    hasBrokerCredentials: true,
    useDemoDataWhenMissingApi: false,
    etfSymbols: ["SPY"],
    defaultUniverseName: "S&P 500 + Nasdaq 100",
    defaultUniverseCount: 500
  },
  warnings: [],
  watchlist: [],
  runtimeCache: { fmpFundamentalsCache: { payload: "x".repeat(20_000) } },
  cachedAt: "2026-07-16T12:00:00.000Z",
  scanStatus: "running",
  lastScanFinishedAt: "2026-07-16T11:59:00.000Z",
  isRefreshing: true
};

describe("browser session cache", () => {
  it("round-trips a compressed snapshot and clears transient running state", async () => {
    const storage = new MemoryStorage();
    await saveBrowserSession(snapshot, storage);

    const restored = await loadBrowserSession(storage);

    expect(restored?.runtimeCache).toEqual(snapshot.runtimeCache);
    expect(restored?.scanStatus).toBe("complete");
    expect(restored?.isRefreshing).toBe(false);
  });

  it("ignores malformed cache entries and supports explicit clearing", async () => {
    const storage = new MemoryStorage();
    storage.setItem("trade-screener:local-session:v1", "json:not-json");
    expect(await loadBrowserSession(storage)).toBeUndefined();

    await saveBrowserSession(snapshot, storage);
    clearBrowserSession(storage);
    expect(await loadBrowserSession(storage)).toBeUndefined();
  });
});
