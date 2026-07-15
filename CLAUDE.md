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
npx vitest run server/scoring.test.ts -t "applies the counter-trend discount and flag in a bearish regime"
```

There are two separate TypeScript project configs (`tsconfig.client.json` covers `src/` + `shared/`, `tsconfig.server.json` covers `server/` + `shared/`) referenced from the root `tsconfig.json`. Frontend and backend are typechecked independently.

The dev server requires local HTTPS (`certs/localhost-*.pem`, auto-generated via `openssl` on first boot) because Schwab OAuth requires an HTTPS callback. Set `API_HTTPS=false` to disable (production/Render sets this since it gets HTTPS from the host).

## Architecture

This is a single-tenant local/self-hosted app: an Express API (`server/`) that runs a recurring options-screening scan over an automatic stock+ETF universe, a thin React SPA (`src/main.tsx`, one file, no router/state library) that displays cached results and can trigger a rescan, and `shared/types.ts` with the types both sides import directly (no code generation, no API schema layer).

### Scan pipeline (`server/scanner.ts`)

`runFullScan()` is the orchestrator and the place to start when tracing scan behavior:

1. Resolve the symbol universe (`universe.ts` for the S&P 500 + Nasdaq 100 stock list, `etfUniverse.ts` for the curated/overridable ETF list).
2. Pull quotes/history/options from Schwab (`schwab.ts`) if credentials + tokens exist (`canUseLiveSchwab`); otherwise the scan runs in demo mode using `demoData.ts`.
3. Per symbol (bounded concurrency via `mapLimit`, `SCAN_CONCURRENCY = 4`): merge fundamentals from a source waterfall (Schwab → FMP → 20-day candle history → demo, tracked field-by-field in `Fundamentals.sources`), then call `gradeSetup()` in `scoring.ts` to produce the technical grade.
4. Two enrichment layers run *after* the technical grade and never change the technical grade:
   - **FMP Institutional Edge** (`fmpInstitutionalEdge.ts`) — informational context only (financial scores, analyst grades, insider/ETF data). Never changes grade or Take/Avoid.
   - **Schwab Options Positioning** (`schwabPositioning.ts`) — conservative confirmation/context derived from scan-time call/put activity and a fixed-contract call-OI build from the immediately preceding trading session. Unsigned gamma concentration and bounded-strike max pain are informational; dark-pool and IV Rank remain unavailable. It never changes the technical grade or creates an `Avoid` mark.
5. Results are sorted by setup score → grade → squeeze dot count, cached wholesale (`replaceScanResults`, full delete+reinsert, not a diff), and scan metadata (status, warnings, diagnostics, next refresh time) is written for the frontend to poll.

`shouldIncludeResult()` is the single gate for what actually reaches the dashboard (universe pass, long direction, positive momentum, active daily squeeze, valid entry mode, grade A/B). `classifyFilteredResult()` back-derives *why* a result was filtered for the diagnostics panel — keep it in sync with `shouldIncludeResult()` and the layer/factor names in `shared/types.ts` when either changes.

`normalizeCachedResult()` is a read-path compatibility shim: it recomputes fields (dot count, grade, qualification modes, trade-mark reasons) for scan results that were cached under an older shape. Any change to `ScanResult`, grading thresholds, or grade-cap reason strings in `scoring.ts` needs a matching fallback here or previously-cached rows will render inconsistently with a fresh scan until the next refresh replaces them.

### Grading engine (`server/scoring.ts`, `indicators.ts`, `entryZone.ts`, `timeframes.ts`)

`scoring.ts` is pure and side-effect-free — it takes candles/fundamentals/options in and returns a `ScanResult` with grade, layer evaluations, and institutional factor scores. Key pieces it composes:

- `indicators.ts` — EMA/SMA/ATR, the Squeeze Pro-style compression state machine (`squeezeState`, `activeSqueezeDotCount`: requires Bollinger Bands inside Keltner Channel), and the 20-period linear-regression-smoothed momentum histogram.
- `entryZone.ts` — classifies daily price location relative to the EMA stack into `strict`/`extended`/`none` entry qualification modes.
- `timeframes.ts` — aggregates daily candles into weekly (`aggregateDailyCandlesToWeeks`) for weekly context, which is bonus confirmation only and cannot reject or degrade a grade below what daily analysis earned (only bearish weekly still rejects).
- Grade thresholds live as named constants (`A_SETUP_SCORE_THRESHOLD = 90`, `B_SETUP_SCORE_THRESHOLD = 70`) and every grade-capping reason is a named exported string constant (e.g. `BROAD_ENTRY_GRADE_CAP_REASON`) — reuse these constants rather than re-deriving the message text, since `scanner.ts`'s cache-normalization path matches against them.

### External data providers (`schwab.ts`, `schwabPositioning.ts`, `fmp.ts`, `fmpInstitutionalEdge.ts`)

Scan providers expose an `enrich()` call and a `flush()` when they persist bounded state. FMP has call-budget and TTL settings in `config.ts`; Schwab positioning has a per-scan request cap and persists at most two snapshots of 40 call-OI cohort entries for 250 symbols. It never archives quotes, descriptions, raw chains, or trades. `httpRetry.ts` (`fetchWithRetry`) is the shared retry-with-backoff wrapper used across the HTTP clients for 429/5xx responses.

Schwab is the only source of live quotes/history/options; FMP and demo data exist purely as fallbacks when Schwab is unavailable or omits a field — this waterfall ordering (Schwab → FMP → history-derived → demo) is threaded through `mergeFundamentals()`/`withCandleLiquidityFallback()` in `scanner.ts` and tracked per-field in `Fundamentals.sources` so the UI/warnings can say which source supplied a value.

### Persistence (`server/sqlite.ts`)

Every exported function in `sqlite.ts` has two implementations gated on `usePostgres` (true when `DATABASE_URL` is set): a `better-sqlite3` path (local dev, WAL mode, file at `data/screener.sqlite`) and a `pg` path (production, typically Supabase). When adding or changing a query here, both branches need to be updated — there's no query builder or migration framework abstracting this away. `migrateNullableFundamentals()` is an in-place SQLite schema migration run at startup (drop NOT NULL from `fundamentals` columns); Postgres was created with the nullable schema from the start so it doesn't need the equivalent.

Two Supabase-egress guards live here and should be preserved: `scan_results`/`watchlist` payloads are stored gzip+base64 (`serializePayload`/`parsePayload`, `gz:` prefix; pre-compression plain-JSON rows still parse), and the multi-megabyte provider caches in `LAZY_HYDRATION_KEYS` are excluded from startup cache hydration and only fetched from the database when a scan first asks for them (a new provider cache setting that grows large should be added to that set).

### Universe management (`server/universe.ts`, `defaultUniverse.ts`, `etfUniverse.ts`)

The stock universe is always S&P 500 + Nasdaq 100 (no user-managed watchlist-as-universe workflow). Refresh waterfall: FMP index constituent endpoints → public S&P 500/Nasdaq 100 source-page scraping (`parseSp500Constituents`, `parseNasdaq100Symbols`) → the bundled `defaultUniverseSymbols` list in `defaultUniverse.ts` as last resort. Refreshed on server startup if no valid cache exists, and monthly via the cron job in `index.ts`. `MIN_REFRESHED_SYMBOLS = 450` guards against accepting a truncated/bad refresh.

### Scheduling (`server/index.ts`)

Scans are manual-only: the user triggers them from the dashboard via `POST /api/scan` (rate-limited). There is deliberately no scan cron and no automatic/opportunistic rescan on dashboard polls — recurring scans were removed to keep Supabase egress inside the free-tier quota, so don't reintroduce one without discussing it. The one remaining `node-cron` job is the monthly universe refresh: a check on the last few days of each month that fires on the actual last day (evaluated in `America/Chicago` via `isLastDayOfMonth`). The frontend still polls read-only endpoints while the market is open (`isMarketRefreshWindow` in `shared/refreshSchedule.ts`) to overlay live Schwab quote prices; those reads are served from the in-memory persistence cache and never touch the database.

### Frontend (`src/main.tsx`)

Deliberately a single ~900-line file: one `App` component, a plain `api` object wrapping `fetch` calls to the Express routes, `React.useState` only (no router, no global state library, no component library beyond `lucide-react` icons). Treat this as the existing convention rather than a gap to fix — don't introduce a router/state library without discussing it first.
