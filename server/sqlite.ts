import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import type { ScanMetadata } from "../shared/types";

const dbPath = resolve("data/screener.sqlite");
const databaseUrl = process.env.DATABASE_URL ?? "";
const usePostgres = Boolean(databaseUrl);
const databaseSsl = process.env.DATABASE_SSL;
const usePostgresSsl = databaseSsl
  ? databaseSsl !== "false"
  : isSupabaseDatabaseUrl(databaseUrl);
const pool = usePostgres
  ? new pg.Pool({
    connectionString: databaseUrl,
    ssl: usePostgresSsl ? { rejectUnauthorized: false } : undefined
  })
  : undefined;

let db: Database.Database | undefined;
const settingsCache = new Map<string, unknown>();
let scanResultsCache: unknown[] = [];
let watchlistCache: Array<{ symbol: string; addedAt: string; payload: unknown }> = [];
let cacheHydrated = false;
const databaseReadStats = { settings: 0, scanResults: 0, watchlist: 0 };

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export async function initDb() {
  if (usePostgres) {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scan_results (
        symbol TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fundamentals (
        symbol TEXT PRIMARY KEY,
        beta DOUBLE PRECISION,
        market_cap DOUBLE PRECISION,
        avg_dollar_volume_20d DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchlist (
        symbol TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);
    await hydratePersistenceCache();
    return;
  }

  getDb().exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scan_results (
        symbol TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fundamentals (
        symbol TEXT PRIMARY KEY,
        beta REAL,
        market_cap REAL,
        avg_dollar_volume_20d REAL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchlist (
        symbol TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await migrateNullableFundamentals();
  await hydratePersistenceCache();
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  if (cacheHydrated) return (settingsCache.has(key) ? settingsCache.get(key) : fallback) as T;
  if (usePostgres) {
    const rows = (await pgQuery<{ value: string }>("SELECT value FROM settings WHERE key = $1;", [key])).rows;
    if (!rows[0]) return fallback;
    return JSON.parse(rows[0].value) as T;
  }
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?;").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  return JSON.parse(row.value) as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  if (usePostgres) {
    await pgQuery(`
      INSERT INTO settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `, [key, payload]);
    settingsCache.set(key, value);
    return;
  }
  getDb().prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `).run(key, payload);
  settingsCache.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  if (usePostgres) {
    await pgQuery("DELETE FROM settings WHERE key = $1;", [key]);
    settingsCache.delete(key);
    return;
  }
  getDb().prepare("DELETE FROM settings WHERE key = ?;").run(key);
  settingsCache.delete(key);
}

export async function saveScanResult(symbol: string, payload: unknown): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  const serialized = JSON.stringify(payload);
  const updatedAt = new Date().toISOString();
  if (usePostgres) {
    await pgQuery(`
      INSERT INTO scan_results (symbol, payload, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `, [upperSymbol, serialized, updatedAt]);
    return;
  }
  getDb().prepare(`
      INSERT INTO scan_results (symbol, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `).run(upperSymbol, serialized, updatedAt);
}

export async function replaceScanResults(results: Array<{ symbol: string }>): Promise<void> {
  if (usePostgres) {
    const client = await pgClient();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM scan_results;");
      for (const result of results) {
        await client.query(`
          INSERT INTO scan_results (symbol, payload, updated_at)
          VALUES ($1, $2, $3)
          ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
        `, [result.symbol.toUpperCase(), JSON.stringify(result), new Date().toISOString()]);
      }
      await client.query("COMMIT");
      scanResultsCache = results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const updatedAt = new Date().toISOString();
  const upsert = getDb().prepare(`
      INSERT INTO scan_results (symbol, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `);
  const replaceAll = getDb().transaction((rows: Array<{ symbol: string }>) => {
    getDb().prepare("DELETE FROM scan_results;").run();
    for (const result of rows) {
      upsert.run(result.symbol.toUpperCase(), JSON.stringify(result), updatedAt);
    }
  });
  replaceAll(results);
  scanResultsCache = results;
}

export async function getCachedResults(): Promise<unknown[]> {
  if (cacheHydrated) return scanResultsCache;
  if (usePostgres) {
    const rows = (await pgQuery<{ payload: string }>("SELECT payload FROM scan_results ORDER BY updated_at DESC;")).rows;
    return rows.map((row) => JSON.parse(row.payload));
  }
  const rows = getDb().prepare("SELECT payload FROM scan_results ORDER BY updated_at DESC;").all() as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload));
}

export async function upsertWatchlistEntry(symbol: string, payload: unknown): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  const serialized = JSON.stringify(payload);
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgQuery(`
      INSERT INTO watchlist (symbol, payload, added_at, updated_at)
      VALUES ($1, $2, $3, $3)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `, [upperSymbol, serialized, now]);
    const existing = watchlistCache.find((entry) => entry.symbol === upperSymbol);
    watchlistCache = [
      { symbol: upperSymbol, addedAt: existing?.addedAt ?? now, payload },
      ...watchlistCache.filter((entry) => entry.symbol !== upperSymbol)
    ];
    return;
  }
  getDb().prepare(`
      INSERT INTO watchlist (symbol, payload, added_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `).run(upperSymbol, serialized, now, now);
  const existing = watchlistCache.find((entry) => entry.symbol === upperSymbol);
  watchlistCache = [
    { symbol: upperSymbol, addedAt: existing?.addedAt ?? now, payload },
    ...watchlistCache.filter((entry) => entry.symbol !== upperSymbol)
  ];
}

export async function getWatchlistEntries(): Promise<Array<{ symbol: string; addedAt: string; payload: unknown }>> {
  if (cacheHydrated) return watchlistCache;
  if (usePostgres) {
    // pg parses TIMESTAMPTZ columns into Date objects; normalize to the ISO
    // string the SQLite branch (TEXT column) returns.
    const rows = (await pgQuery<{ symbol: string; payload: string; added_at: string | Date }>(
      "SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;"
    )).rows;
    return rows.map((row) => ({
      symbol: row.symbol,
      addedAt: typeof row.added_at === "string" ? row.added_at : row.added_at.toISOString(),
      payload: JSON.parse(row.payload)
    }));
  }
  const rows = getDb().prepare("SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;")
    .all() as { symbol: string; payload: string; added_at: string }[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at, payload: JSON.parse(row.payload) }));
}

export async function removeWatchlistEntry(symbol: string): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  if (usePostgres) {
    await pgQuery("DELETE FROM watchlist WHERE symbol = $1;", [upperSymbol]);
    watchlistCache = watchlistCache.filter((entry) => entry.symbol !== upperSymbol);
    return;
  }
  getDb().prepare("DELETE FROM watchlist WHERE symbol = ?;").run(upperSymbol);
  watchlistCache = watchlistCache.filter((entry) => entry.symbol !== upperSymbol);
}

export function getDatabaseReadStats() {
  return { ...databaseReadStats };
}

async function hydratePersistenceCache(): Promise<void> {
  if (cacheHydrated) return;
  if (usePostgres) {
    const [settings, results, watchlist] = await Promise.all([
      pgQuery<{ key: string; value: string }>("SELECT key, value FROM settings;"),
      pgQuery<{ payload: string }>("SELECT payload FROM scan_results ORDER BY updated_at DESC;"),
      pgQuery<{ symbol: string; payload: string; added_at: string | Date }>("SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;")
    ]);
    databaseReadStats.settings += 1;
    databaseReadStats.scanResults += 1;
    databaseReadStats.watchlist += 1;
    for (const row of settings.rows) settingsCache.set(row.key, JSON.parse(row.value));
    scanResultsCache = results.rows.map((row) => JSON.parse(row.payload));
    watchlistCache = watchlist.rows.map((row) => ({
      symbol: row.symbol,
      addedAt: typeof row.added_at === "string" ? row.added_at : row.added_at.toISOString(),
      payload: JSON.parse(row.payload)
    }));
  } else {
    const settings = getDb().prepare("SELECT key, value FROM settings;").all() as Array<{ key: string; value: string }>;
    const results = getDb().prepare("SELECT payload FROM scan_results ORDER BY updated_at DESC;").all() as Array<{ payload: string }>;
    const watchlist = getDb().prepare("SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;").all() as Array<{ symbol: string; payload: string; added_at: string }>;
    databaseReadStats.settings += 1;
    databaseReadStats.scanResults += 1;
    databaseReadStats.watchlist += 1;
    for (const row of settings) settingsCache.set(row.key, JSON.parse(row.value));
    scanResultsCache = results.map((row) => JSON.parse(row.payload));
    watchlistCache = watchlist.map((row) => ({ symbol: row.symbol, addedAt: row.added_at, payload: JSON.parse(row.payload) }));
  }
  cacheHydrated = true;
  console.info("Persistence cache hydrated", {
    settings: settingsCache.size,
    scanResults: scanResultsCache.length,
    watchlist: watchlistCache.length,
    databaseReads: getDatabaseReadStats()
  });
}

export async function getScanMetadata(): Promise<ScanMetadata> {
  return getSetting<ScanMetadata>("scanMetadata", { scanStatus: "idle" });
}

export async function setScanMetadata(value: ScanMetadata): Promise<void> {
  await setSetting("scanMetadata", value);
}

async function migrateNullableFundamentals() {
  const rows = getDb().prepare("PRAGMA table_info(fundamentals);").all() as Array<{ name: string; notnull: number }>;
  const betaRequired = rows.some((row) => row.name === "beta" && row.notnull === 1);
  const marketCapRequired = rows.some((row) => row.name === "market_cap" && row.notnull === 1);
  if (!betaRequired && !marketCapRequired) return;

  getDb().exec(`
    ALTER TABLE fundamentals RENAME TO fundamentals_old;
    CREATE TABLE fundamentals (
      symbol TEXT PRIMARY KEY,
      beta REAL,
      market_cap REAL,
      avg_dollar_volume_20d REAL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO fundamentals (symbol, beta, market_cap, avg_dollar_volume_20d, updated_at)
    SELECT symbol, beta, market_cap, avg_dollar_volume_20d, updated_at FROM fundamentals_old;
    DROP TABLE fundamentals_old;
  `);
}

async function pgQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
  if (!pool) throw new Error("Postgres pool was not initialized.");
  return pool.query<T>(sql, values);
}

async function pgClient(): Promise<pg.PoolClient> {
  if (!pool) throw new Error("Postgres pool was not initialized.");
  return pool.connect();
}

function isSupabaseDatabaseUrl(url: string): boolean {
  return /(?:supabase\.co|supabase\.com)/i.test(url);
}
