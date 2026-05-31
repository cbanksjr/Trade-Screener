import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ScanMetadata } from "../shared/types";

const dbPath = resolve("data/screener.sqlite");

function runSql(sql: string): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  return execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
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

export function replaceScanResults(results: Array<{ symbol: string }>) {
  runSql("DELETE FROM scan_results;");
  for (const result of results) {
    saveScanResult(result.symbol, result);
  }
}

export function getCachedResults() {
  const rows = JSON.parse(runSql("SELECT payload FROM scan_results ORDER BY updated_at DESC;") || "[]") as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload));
}

export function getScanMetadata(): ScanMetadata {
  return getSetting<ScanMetadata>("scanMetadata", { scanStatus: "idle" });
}

export function setScanMetadata(value: ScanMetadata) {
  setSetting("scanMetadata", value);
}


function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
