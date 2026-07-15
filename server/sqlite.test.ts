import Database from "better-sqlite3";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSetting, initDb, setSetting } from "./sqlite";

// These tests exercise the local better-sqlite3 branch (no DATABASE_URL). Keys in
// LAZY_HYDRATION_KEYS are skipped during startup hydration, so getSetting on them
// misses the in-memory settingsCache and actually reads the row back from the
// database through parsePayload. Each cache-bypassing read uses its own key so the
// tests stay independent (getSetting memoizes a lazy key after its first read).
const WRITE_KEY = "schwabPositioningSnapshotsV2"; // round-trip write path (populates cache)
const GZIP_READ_KEY = "fmpInstitutionalEdgeCompactCacheV2"; // cache-free gzip read path
const LEGACY_READ_KEY = "fmpFundamentalsCache"; // cache-free legacy plain-JSON read path
const TOUCHED_KEYS = [WRITE_KEY, GZIP_READ_KEY, LEGACY_READ_KEY];
const REMOVED_PROVIDER_KEY = "quantDataCompactCacheV2";
const dbPath = resolve("data/screener.sqlite");

function withExternalDb<T>(run: (db: Database.Database) => T): T {
  const external = new Database(dbPath);
  try {
    return run(external);
  } finally {
    external.close();
  }
}

function readRawSettingValue(key: string): string | undefined {
  return withExternalDb((db) => (db.prepare("SELECT value FROM settings WHERE key = ?;").get(key) as { value: string } | undefined)?.value);
}

function writeRawSettingValue(key: string, rawValue: string): void {
  withExternalDb((db) => db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `).run(key, rawValue));
}

function deleteRawSetting(key: string): void {
  withExternalDb((db) => db.prepare("DELETE FROM settings WHERE key = ?;").run(key));
}

describe("settings value compression", () => {
  // Snapshot any real provider-cache rows so these tests are non-destructive.
  const originalValues = new Map<string, string | undefined>();

  beforeAll(async () => {
    await initDb();
    for (const key of TOUCHED_KEYS) originalValues.set(key, readRawSettingValue(key));
  });

  afterAll(() => {
    for (const key of TOUCHED_KEYS) {
      const original = originalValues.get(key);
      if (original === undefined) deleteRawSetting(key);
      else writeRawSettingValue(key, original);
    }
    deleteRawSetting(REMOVED_PROVIDER_KEY);
  });

  it("stores settings values gzip-compressed and round-trips them", async () => {
    const value = { hello: "world", nums: [1, 2, 3], big: "x".repeat(2000) };

    await setSetting(WRITE_KEY, value);

    // The write path must persist a gz:-prefixed value, not plain JSON.
    const raw = readRawSettingValue(WRITE_KEY);
    expect(raw?.startsWith("gz:")).toBe(true);
    expect(raw).not.toBe(JSON.stringify(value));

    // Round-trip through the public API.
    expect(await getSetting(WRITE_KEY, null)).toEqual(value);

    // Copy the exact compressed bytes to a cache-free key so getSetting decodes
    // them straight from the database via parsePayload (not the write-time cache).
    writeRawSettingValue(GZIP_READ_KEY, raw!);
    expect(await getSetting(GZIP_READ_KEY, null)).toEqual(value);
  });

  it("still reads legacy plain-JSON settings rows written before compression", async () => {
    const value = { legacy: true, list: ["a", "b"], nested: { n: 1 } };

    // Simulate a row persisted before compression existed: bare JSON.stringify.
    writeRawSettingValue(LEGACY_READ_KEY, JSON.stringify(value));
    expect(readRawSettingValue(LEGACY_READ_KEY)?.startsWith("gz:")).toBe(false);

    expect(await getSetting(LEGACY_READ_KEY, null)).toEqual(value);
  });

  it("removes the obsolete QuantData provider cache during initialization", async () => {
    writeRawSettingValue(REMOVED_PROVIDER_KEY, JSON.stringify({ obsolete: true }));

    await initDb();

    expect(readRawSettingValue(REMOVED_PROVIDER_KEY)).toBeUndefined();
  });
});
