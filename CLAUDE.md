# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install --cache .npm-cache   # install (repo uses a local npm cache dir)
npm run dev                      # runs dev:server (Express API, tsx) + dev:client (Vite) concurrently
npm run build                    # tsc -b (typecheck both tsconfig projects) then vite build
npm start                        # production: node --import tsx server/index.ts (serves built dist/ too)
npm test                         # vitest run (all *.test.ts under server/)
npm run typecheck                # tsc -b only, no emit
```

Run a single test file or test case with vitest directly:

```bash
npx vitest run server/scanner.test.ts
npx vitest run server/scoring.test.ts -t "promotes a clean B setup"
```

There are two separate TypeScript project configs (`tsconfig.client.json` covers `src/` + `shared/`, `tsconfig.server.json` covers `server/` + `shared/`) referenced from the root `tsconfig.json`. Frontend and backend are typechecked independently.

The dev server requires local HTTPS (`certs/localhost-*.pem`, auto-generated via `openssl` on first boot) because Schwab OAuth requires an HTTPS callback. Set `API_HTTPS=false` to disable (production/Render sets this since it gets HTTPS from the host).

## Architecture

This is a single-tenant local/self-hosted app: an Express API (`server/`) that runs a recurring options-screening scan over an automatic stock+ETF universe, a thin React SPA (`src/main.tsx`, one file, no router/state library) that displays cached results and can trigger a rescan, and `shared/types.ts` with the types both sides import directly (no code generation, no API schema layer).

### Scan pipeline (`server/scanner.ts`)

`runFullScan()` is the orchestrator and the place to start when tracing scan behavior:

1. Resolve the symbol universe (`universe.ts` for the S&P 500 + Nasdaq 100 stock list, `etfUniverse.ts` for the curated/overridable ETF list).
2. Pull quotes/history/options from Schwab (`schwab.ts`) if credentials + tokens exist (`canUseLiveSchwab`); otherwise the scan runs in demo mode using `demoData.ts`.
3. Optional QuantData Gainers-Losers pass reorders (never filters) the symbol list once per scan so QuantData's limited per-symbol call budget goes to names with real same-day movement first.
4. Per symbol (bounded concurrency via `mapLimit`, `SCAN_CONCURRENCY = 4`): merge fundamentals from a source waterfall (Schwab → FMP → 20-day candle history → demo, tracked field-by-field in `Fundamentals.sources`), then call `gradeSetup()` in `scoring.ts` to produce the technical grade.
5. Two optional enrichment layers run *after* the technical grade and only affect Take/Avoid + grade promotion, never invent a grade from nothing:
   - **FMP Institutional Edge** (`fmpInstitutionalEdge.ts`) — informational context only (financial scores, analyst grades, insider/ETF data). Never changes grade or Take/Avoid.
   - **QuantData Institutional Positioning** (`quantData.ts`) — can promote a clean technical B to A (`gradeBeforeQuantData` → `finalGrade`, `institutionalPromotionApplied`) when enough of {bullish flow, supportive exposure, dark-pool accumulation, confirmed OI build, confirming IV Rank} line up with zero vetoes, and can cap/veto a setup to Avoid on hostile gamma walls or max-pain pin risk. It can never demote a setup below what the technical score already earned.
6. Results are sorted by setup score → grade → squeeze dot count, cached wholesale (`replaceScanResults`, full delete+reinsert, not a diff), and scan metadata (status, warnings, diagnostics, next refresh time) is written for the frontend to poll.

`shouldIncludeResult()` is the single gate for what actually reaches the dashboard (universe pass, long direction, positive momentum, active daily squeeze, valid entry mode, grade A/B). `classifyFilteredResult()` back-derives *why* a result was filtered for the diagnostics panel — keep it in sync with `shouldIncludeResult()` and the layer/factor names in `shared/types.ts` when either changes.

`normalizeCachedResult()` is a read-path compatibility shim: it recomputes fields (dot count, grade, qualification modes, trade-mark reasons) for scan results that were cached under an older shape. Any change to `ScanResult`, grading thresholds, or grade-cap reason strings in `scoring.ts` needs a matching fallback here or previously-cached rows will render inconsistently with a fresh scan until the next refresh replaces them.

### Grading engine (`server/scoring.ts`, `indicators.ts`, `entryZone.ts`, `timeframes.ts`)

`scoring.ts` is pure and side-effect-free — it takes candles/fundamentals/options in and returns a `ScanResult` with grade, layer evaluations, and institutional factor scores. Key pieces it composes:

- `indicators.ts` — EMA/SMA/ATR, the Squeeze Pro-style compression state machine (`squeezeState`, `activeSqueezeDotCount`: requires Bollinger Bands inside Keltner Channel), and the 20-period linear-regression-smoothed momentum histogram.
- `entryZone.ts` — classifies daily price location relative to the EMA stack into `strict`/`broad`/`extended`/`none` entry qualification modes.
- `timeframes.ts` — aggregates daily candles into weekly (`aggregateDailyCandlesToWeeks`) for weekly context, which is bonus confirmation only and cannot reject or degrade a grade below what daily analysis earned (only bearish weekly still rejects).
- Grade thresholds live as named constants (`A_SETUP_SCORE_THRESHOLD = 90`, `B_SETUP_SCORE_THRESHOLD = 70`) and every grade-capping reason is a named exported string constant (e.g. `BROAD_ENTRY_GRADE_CAP_REASON`) — reuse these constants rather than re-deriving the message text, since `scanner.ts`'s cache-normalization path matches against them.

### External data providers (`schwab.ts`, `fmp.ts`, `fmpInstitutionalEdge.ts`, `quantData.ts`)

All follow the same shape: a `createXScanProvider()` factory sets up a per-scan cache and call budget, exposes an `enrich()`/`rankSymbols()` call per symbol, and a `flush()` to persist the cache at the end of the scan. Each has its own max-calls-per-scan and TTL settings in `config.ts` to protect free-tier API limits (`FMP_MAX_CALLS_PER_SCAN`, `QUANTDATA_MAX_CALLS_PER_SCAN`, `FMP_INSTITUTIONAL_EDGE_PROBE_TTL_HOURS`, etc.). `httpRetry.ts` (`fetchWithRetry`) is the shared retry-with-backoff wrapper used across these HTTP clients for 429/5xx responses.

Schwab is the only source of live quotes/history/options; FMP and demo data exist purely as fallbacks when Schwab is unavailable or omits a field — this waterfall ordering (Schwab → FMP → history-derived → demo) is threaded through `mergeFundamentals()`/`withCandleLiquidityFallback()` in `scanner.ts` and tracked per-field in `Fundamentals.sources` so the UI/warnings can say which source supplied a value.

### Persistence (`server/sqlite.ts`)

Every exported function in `sqlite.ts` has two implementations gated on `usePostgres` (true when `DATABASE_URL` is set): a `better-sqlite3` path (local dev, WAL mode, file at `data/screener.sqlite`) and a `pg` path (production, typically Supabase). When adding or changing a query here, both branches need to be updated — there's no query builder or migration framework abstracting this away. `migrateNullableFundamentals()` is an in-place SQLite schema migration run at startup (drop NOT NULL from `fundamentals` columns); Postgres was created with the nullable schema from the start so it doesn't need the equivalent.

### Universe management (`server/universe.ts`, `defaultUniverse.ts`, `etfUniverse.ts`)

The stock universe is always S&P 500 + Nasdaq 100 (no user-managed watchlist-as-universe workflow). Refresh waterfall: FMP index constituent endpoints → public S&P 500/Nasdaq 100 source-page scraping (`parseSp500Constituents`, `parseNasdaq100Symbols`) → the bundled `defaultUniverseSymbols` list in `defaultUniverse.ts` as last resort. Refreshed on server startup if no valid cache exists, and monthly via the cron job in `index.ts`. `MIN_REFRESHED_SYMBOLS = 450` guards against accepting a truncated/bad refresh.

### Scheduling (`server/index.ts`)

Two `node-cron` jobs, both pinned to `America/Chicago`: weekday 8:35am scan refresh, and a check on the last few days of each month that triggers a universe refresh on the actual last day. Client-triggered refresh also happens via `shouldAutoRefresh()`/`AUTO_REFRESH_MS` (15 min) when the dashboard is polled and Schwab is connected — Render's free tier can sleep, so cached results always render first and a background refresh kicks off opportunistically rather than relying solely on cron.

### Frontend (`src/main.tsx`)

Deliberately a single ~900-line file: one `App` component, a plain `api` object wrapping `fetch` calls to the Express routes, `React.useState` only (no router, no global state library, no component library beyond `lucide-react` icons). Treat this as the existing convention rather than a gap to fix — don't introduce a router/state library without discussing it first.
