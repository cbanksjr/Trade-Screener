import { beforeEach, describe, expect, it } from "vitest";
import {
  getCachedResults,
  getScanMetadata,
  getSetting,
  getWatchlistEntries,
  removeWatchlistEntry,
  replaceScanResults,
  resetMemoryStoreForTests,
  setScanMetadata,
  setSetting,
  upsertWatchlistEntry
} from "./memoryStore";

describe("memory store", () => {
  beforeEach(() => resetMemoryStoreForTests());

  it("keeps settings, scan results, and metadata in process memory", async () => {
    await setSetting("example", { ok: true });
    await replaceScanResults([{ symbol: "AAPL" }]);
    await setScanMetadata({ scanStatus: "complete", lastScanFinishedAt: "2026-07-16T12:00:00.000Z" });

    expect(await getSetting("example", null)).toEqual({ ok: true });
    expect(await getCachedResults()).toEqual([{ symbol: "AAPL" }]);
    expect(await getScanMetadata()).toMatchObject({ scanStatus: "complete" });
  });

  it("preserves watchlist timestamps across updates", async () => {
    const addedAt = "2026-07-15T12:00:00.000Z";
    await upsertWatchlistEntry("aapl", { price: 100 }, addedAt);
    await upsertWatchlistEntry("AAPL", { price: 101 });

    expect(await getWatchlistEntries()).toEqual([{ symbol: "AAPL", addedAt, payload: { price: 101 } }]);
    await removeWatchlistEntry("aapl");
    expect(await getWatchlistEntries()).toEqual([]);
  });

  it("drops all state when the process-local store is reset", async () => {
    await setSetting("example", true);
    await replaceScanResults([{ symbol: "MSFT" }]);
    resetMemoryStoreForTests();

    expect(await getSetting("example", false)).toBe(false);
    expect(await getCachedResults()).toEqual([]);
  });
});
