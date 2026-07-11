# AGENTS.md

## Project Overview

This is a local TypeScript options swing screener. It has a Vite/React frontend and an Express/Node backend that scans S&P 500, Nasdaq 100, and selected ETF symbols for long-call compression setups.

Read `README.md` before changing scanner behavior. It documents the trading rules, grading model, Schwab/FMP/QuantData usage, hosting setup, and expected scan behavior.

## Common Commands

- Install: `npm install --cache .npm-cache`
- Dev server: `npm run dev`
- Backend only: `npm run dev:server`
- Frontend only: `npm run dev:client`
- Tests: `npm test`
- Typecheck: `npm run typecheck`
- Production build: `npm run build`
- Production start: `npm start`

Local frontend runs at `http://127.0.0.1:5173`.
Local API defaults to `https://127.0.0.1:4173`.

## Architecture

- `src/` contains the React UI.
- `server/index.ts` owns API routes, cron refreshes, static hosting, and local HTTPS setup.
- `server/scanner.ts` coordinates scan execution, cached results, settings, and provider enrichment.
- `server/scoring.ts` owns grading, setup quality, trade marks, and layer evaluation logic.
- `server/indicators.ts` owns EMA, ATR, squeeze, and momentum calculations.
- `server/schwab.ts`, `server/fmp.ts`, and `server/quantData.ts` isolate external data providers.
- `server/sqlite.ts` handles local SQLite and hosted Postgres persistence.
- `shared/types.ts` is the contract between server and frontend.

## Environment And Secrets

Do not commit `.env`, API keys, OAuth tokens, generated certs, local databases, build output, or `node_modules`.

Important environment variables include:

- `SCHWAB_APP_KEY`
- `SCHWAB_APP_SECRET`
- `SCHWAB_CALLBACK_URL`
- `API_HTTPS`
- `FMP_API_KEY`
- `QUANTDATA_API_KEY`
- `DATABASE_URL`
- `DATABASE_SSL`
- `PUBLIC_URL`
- `CLIENT_ORIGIN`
- `ETF_SYMBOLS`

Use `.env.example` as the template.

## Generated And Local Files

Treat these as generated/local state unless the user explicitly asks otherwise:

- `.npm-cache/`
- `node_modules/`
- `dist/`
- `dist-server/`
- `data/`
- `certs/`
- `*.tsbuildinfo`

## Development Rules

Preserve the scanner's domain rules unless the user explicitly asks to change them. In particular:

- A/B setup grades are based on setup score.
- `Take`/`Avoid` is separate from setup grade.
- Weekly squeeze is contextual only.
- QuantData can confirm, cap, veto, or promote clean B setups, but should not demote below the technical grade.
- FMP Institutional Edge is informational unless README/spec says otherwise.
- ETFs bypass stock-only beta, market-cap, sector, and earnings requirements.

Prefer changing provider-specific files for API mapping issues and `scoring.ts` for grading behavior. Keep `shared/types.ts` in sync with frontend and server changes.

## Testing Guidance

Run `npm test` after changes to scanner, scoring, indicators, providers, universe handling, or persistence.

Run `npm run typecheck` after TypeScript contract changes.

Run `npm run build` before finishing frontend or full-stack changes.

Add or update focused Vitest tests near the changed module. Existing tests live beside server modules as `*.test.ts`.

## Frontend Guidance

The UI is a dense analyst workbench, not a marketing page. Keep controls compact, readable, and consistent with the existing dashboard style. Use existing patterns in `src/main.tsx` and `src/styles.css`.

Do not add decorative landing-page sections. Preserve the cached-results-first workflow and background refresh behavior.
