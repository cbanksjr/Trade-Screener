import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = resolve("data/screener.sqlite");

function runSql(sql: string): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  return execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
}

export function initDb() {
  runSql(`
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
  migrateNullableFundamentals();
}

export function getSetting<T>(key: string, fallback: T): T {
  const rows = JSON.parse(runSql(`SELECT value FROM settings WHERE key = ${quote(key)};`) || "[]") as { value: string }[];
  if (!rows[0]) return fallback;
  return JSON.parse(rows[0].value) as T;
}

export function setSetting(key: string, value: unknown) {
  runSql(`
    INSERT INTO settings (key, value)
    VALUES (${quote(key)}, ${quote(JSON.stringify(value))})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
}

export function saveScanResult(symbol: string, payload: unknown) {
  runSql(`
    INSERT INTO scan_results (symbol, payload, updated_at)
    VALUES (${quote(symbol.toUpperCase())}, ${quote(JSON.stringify(payload))}, ${quote(new Date().toISOString())})
    ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `);
}

export function getCachedResults() {
  const rows = JSON.parse(runSql("SELECT payload FROM scan_results ORDER BY updated_at DESC;") || "[]") as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload));
}

export function upsertFundamental(symbol: string, beta?: number, marketCap?: number, avgDollarVolume20d?: number) {
  runSql(`
    INSERT INTO fundamentals (symbol, beta, market_cap, avg_dollar_volume_20d, updated_at)
    VALUES (${quote(symbol.toUpperCase())}, ${sqlNumber(beta)}, ${sqlNumber(marketCap)}, ${sqlNumber(avgDollarVolume20d)}, ${quote(new Date().toISOString())})
    ON CONFLICT(symbol) DO UPDATE SET
      beta = excluded.beta,
      market_cap = excluded.market_cap,
      avg_dollar_volume_20d = excluded.avg_dollar_volume_20d,
      updated_at = excluded.updated_at;
  `);
}

export function getFundamentals() {
  const rows = JSON.parse(runSql("SELECT symbol, beta, market_cap, avg_dollar_volume_20d FROM fundamentals;") || "[]") as Array<{
    symbol: string;
    beta?: number | null;
    market_cap?: number | null;
    avg_dollar_volume_20d?: number;
  }>;
  return new Map(rows.map((row) => [row.symbol, {
    symbol: row.symbol,
    beta: row.beta ?? undefined,
    marketCap: row.market_cap ?? undefined,
    avgDollarVolume20d: row.avg_dollar_volume_20d
  }]));
}

export function getFundamentalSymbols(): string[] {
  const rows = JSON.parse(runSql("SELECT symbol FROM fundamentals ORDER BY symbol;") || "[]") as Array<{ symbol: string }>;
  return rows.map((row) => row.symbol);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : "NULL";
}

function migrateNullableFundamentals() {
  const rows = JSON.parse(runSql("PRAGMA table_info(fundamentals);") || "[]") as Array<{ name: string; notnull: number }>;
  const betaRequired = rows.some((row) => row.name === "beta" && row.notnull === 1);
  const marketCapRequired = rows.some((row) => row.name === "market_cap" && row.notnull === 1);
  if (!betaRequired && !marketCapRequired) return;

  runSql(`
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
