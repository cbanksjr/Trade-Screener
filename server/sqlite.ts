import { execFileSync } from "node:child_process";
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

function runSql(sql: string): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  return execFileSync("sqlite3", ["-json", "-cmd", ".timeout 5000", dbPath, sql], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
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
    `);
    return;
  }

  await sqliteRun(`
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
    `);
  await migrateNullableFundamentals();
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = usePostgres
    ? (await pgQuery<{ value: string }>("SELECT value FROM settings WHERE key = $1;", [key])).rows
    : JSON.parse(await sqliteRun(`SELECT value FROM settings WHERE key = ${quote(key)};`) || "[]") as { value: string }[];
  if (!rows[0]) return fallback;
  return JSON.parse(rows[0].value) as T;
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
  await sqliteRun(`
      INSERT INTO settings (key, value)
      VALUES (${quote(key)}, ${quote(payload)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
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
  await sqliteRun(`
      INSERT INTO scan_results (symbol, payload, updated_at)
      VALUES (${quote(upperSymbol)}, ${quote(serialized)}, ${quote(updatedAt)})
      ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
    `);
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

  await sqliteRun("DELETE FROM scan_results;");
  for (const result of results) {
    await saveScanResult(result.symbol, result);
  }
}

export async function getCachedResults(): Promise<unknown[]> {
  const rows = usePostgres
    ? (await pgQuery<{ payload: string }>("SELECT payload FROM scan_results ORDER BY updated_at DESC;")).rows
    : JSON.parse(await sqliteRun("SELECT payload FROM scan_results ORDER BY updated_at DESC;") || "[]") as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload));
}

export async function getScanMetadata(): Promise<ScanMetadata> {
  return getSetting<ScanMetadata>("scanMetadata", { scanStatus: "idle" });
}

export async function setScanMetadata(value: ScanMetadata): Promise<void> {
  await setSetting("scanMetadata", value);
}


function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}


async function migrateNullableFundamentals() {
  const rows = JSON.parse(await sqliteRun("PRAGMA table_info(fundamentals);") || "[]") as Array<{ name: string; notnull: number }>;
  const betaRequired = rows.some((row) => row.name === "beta" && row.notnull === 1);
  const marketCapRequired = rows.some((row) => row.name === "market_cap" && row.notnull === 1);
  if (!betaRequired && !marketCapRequired) return;

  await sqliteRun(`
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

async function sqliteRun(sql: string): Promise<string> {
  return runSql(sql);
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
