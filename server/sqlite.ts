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
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
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
    return;
  }
  getDb().prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `).run(key, payload);
}

export async function deleteSetting(key: string): Promise<void> {
  if (usePostgres) {
    await pgQuery("DELETE FROM settings WHERE key = $1;", [key]);
    return;
  }
  getDb().prepare("DELETE FROM settings WHERE key = ?;").run(key);
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
}

export async function getCachedResults(): Promise<unknown[]> {
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
    return;
  }
  getDb().prepare(`
      INSERT INTO watchlist (symbol, payload, added_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `).run(upperSymbol, serialized, now, now);
}

export async function getWatchlistEntries(): Promise<Array<{ symbol: string; addedAt: string; payload: unknown }>> {
  if (usePostgres) {
    const rows = (await pgQuery<{ symbol: string; payload: string; added_at: string }>(
      "SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;"
    )).rows;
    return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at, payload: JSON.parse(row.payload) }));
  }
  const rows = getDb().prepare("SELECT symbol, payload, added_at FROM watchlist ORDER BY added_at DESC;")
    .all() as { symbol: string; payload: string; added_at: string }[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at, payload: JSON.parse(row.payload) }));
}

export async function removeWatchlistEntry(symbol: string): Promise<void> {
  const upperSymbol = symbol.toUpperCase();
  if (usePostgres) {
    await pgQuery("DELETE FROM watchlist WHERE symbol = $1;", [upperSymbol]);
    return;
  }
  getDb().prepare("DELETE FROM watchlist WHERE symbol = ?;").run(upperSymbol);
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
