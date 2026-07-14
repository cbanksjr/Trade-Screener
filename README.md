# Local Options Swing Screener

A local web app for automatically screening optionable long-call compression candidates using A/B grade badges. It supports long setups against an automatic **S&P 500 + Nasdaq 100 + selected ETFs** universe.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173. Cached scan results load immediately when available; click **Run Scan** to start a background refresh while the cached dashboard stays visible.

The Dashboard displays developing and ready compression setups with a separate `Take` or `Avoid` trade mark. `A` means a setup score of `90-100`; `B` means `70-89`; a five-dot squeeze that currently scores below B can remain visible as a tracked `C`/`Avoid` setup so contextual weakness does not hide the compression before it fires. Weekly squeeze is shown as bonus context only and Weekly EMA structure does not boost, cap, filter, or degrade the setup grade. Hostile overlays such as bearish macro, bearish institutional positioning, or unusable option context mark the trade `Avoid` without changing the setup grade.

The app can open immediately from saved results, but background refreshes need Schwab connected because the full default universe requires live quotes, fundamentals, history, and options data. While connected, automatic refreshes run at most every 15 minutes on weekdays from 8:30 a.m. through 3:00 p.m. America/Chicago. The browser only requests due refreshes while the dashboard is visible, and the server schedule only runs while the service is awake. Demo rows are shown only for an explicitly demo-mode scan; a completed live or mixed scan never surfaces an older demo payload when a symbol-level provider gap occurs. To use Schwab, create a Schwab Developer app, copy `.env.example` to `.env`, and add:

```bash
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:4173/api/schwab/callback
API_HTTPS=true
FMP_API_KEY=your_fmp_key_here
QUANTDATA_API_KEY=your_quantdata_key_here
```

Then restart the dev server. The local API runs HTTPS by default for Schwab OAuth and will generate a local self-signed certificate in `certs/` the first time it starts. The app will show whether Schwab is connected. If credentials are present but no token is stored, click **Connect Schwab** and complete the OAuth login. Schwab must be configured with the exact same HTTPS callback URL as `.env`.

The scan uses Schwab for:

- `/marketdata/v1/quotes` for quote and fundamental market data
- `/marketdata/v1/pricehistory` for daily OHLCV history and weekly context aggregated from daily candles
- `/marketdata/v1/chains` for 14-180 DTE swing call chains with Greeks

Option-chain responses are bounded to 20 strikes per expiration by default to keep full-universe scans within hosted memory limits. Override this with `SCHWAB_OPTION_STRIKE_COUNT` only when the service has enough memory for wider chains.

Financial Modeling Prep can be used for index universe refreshes and as a cached fallback when Schwab omits core institutional fields. Add `FMP_API_KEY` to `.env` or deployment secrets. The app keeps Schwab as primary for market data, then uses FMP to refresh the default universe and fill missing beta, market cap, sector, and next earnings date. Fallback results are cached for 24 hours and live FMP calls are capped by `FMP_MAX_CALLS_PER_SCAN`, default `1000`, to protect API limits.

FMP can also add a Starter-safe Institutional Edge context panel after a symbol already passes the core scan. It probes each optional endpoint with your API key, caches availability for `FMP_INSTITUTIONAL_EDGE_PROBE_TTL_HOURS` hours, and skips endpoints that return plan, permission, malformed entitlement, or rate-limit responses. FMP Institutional Edge is informational only; setup grade and Take/Avoid marks are driven by trading structure and QuantData positioning. Configure it with `FMP_INSTITUTIONAL_EDGE_ENABLED=true`, `FMP_STARTER_SAFE_MODE=true`, and `FMP_INSTITUTIONAL_EDGE_MAX_CALLS_PER_SCAN=250`.

QuantData adds the live Institutional Positioning layer after the base scan and optional FMP context pass. It uses prior-session options net drift/order flow, exposure by strike (dealer gamma walls), dark-pool levels, max pain (expiration pin risk), call open-interest change, and IV Rank (cross-checked against the technical Compression Quality factor) to mark each candidate as `confirmed`, `neutral`, `capped`, or `vetoed`. Bullish positioning can confirm a clean setup, while bearish flow, hostile call-wall exposure, distribution-like dark-pool data, or near-expiration max-pain pin risk can mark a setup as Avoid. Net Drift/Order Flow only reads as `confirmed` when it is corroborated by a genuine overnight call open-interest build, so same-day noise can't count as institutional conviction on its own. Institutional positioning affects only the `Take`/`Avoid` mark; it never promotes, demotes, hides, or removes the technical setup. QuantData also ranks the scan universe once per scan using Gainers-Losers to prioritize per-symbol QuantData spend toward names with real same-day movement first (a scan-ordering signal, not a scoring factor). Configure it with `QUANTDATA_API_KEY`, `QUANTDATA_BASE_URL=https://api.quantdata.us`, `QUANTDATA_ENABLED=true`, `QUANTDATA_MAX_CALLS_PER_SCAN=300`, and `QUANTDATA_CACHE_TTL_MINUTES=15`.

The scanner includes a curated ETF list by default: `SPY`, `QQQ`, `DIA`, `IWM`, `SMH`, `XLK`, `XLF`, `XLV`, `XLE`, `XLY`, `XLI`, `XLC`, `XLP`, `XLU`, `XLB`, and `XLRE`. To override that list, set `ETF_SYMBOLS` to a comma-separated list such as `ETF_SYMBOLS=SPY,QQQ,SMH`.

## Hosting

For a hosted private deployment, use **Supabase Free Postgres** for persistence and a **Render Free Web Service** for the app. SQLite remains the local fallback when `DATABASE_URL` is not set, but hosted deployments should use Supabase so scan results, Schwab OAuth tokens, and cached universe data survive redeploys.

Render Free web services can sleep after inactivity. The app is built around that tradeoff: cached results load first after wake-up, and fresh scans run when you open the app or click **Run Scan**. The scheduled 15-minute refresh is restricted to the regular weekday market window and only runs while Render is awake or a visible dashboard requests a due refresh. This caps the app's automatic keep-awake time near 150 hours in a typical month, well below one Render Free service's current 750-hour workspace allowance. Scan-result rows and provider caches are replaced/upserted rather than appended, limiting Supabase database growth.

Recommended Supabase + Render setup:

- Create a Supabase project.
- In Supabase database connection settings, copy the **Shared Pooler / Session mode** connection string. Do not use the direct IPv6-only connection string for Render Free.
- Create a Render Free Web Service from this GitHub repo.
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Add environment variables in Render:
  - `NODE_ENV=production`
  - `API_HTTPS=false`
  - `DATABASE_URL=<Supabase shared pooler session-mode connection string>`
  - `DATABASE_SSL=true`
  - `PUBLIC_URL=https://trade-screener-auyv.onrender.com`
  - `CLIENT_ORIGIN=https://trade-screener-auyv.onrender.com`
  - `SCHWAB_CALLBACK_URL=https://trade-screener-auyv.onrender.com/api/schwab/callback`
  - `SCHWAB_APP_KEY` and `SCHWAB_APP_SECRET`
  - `FMP_API_KEY`
  - Optional private access gate: `APP_BASIC_AUTH_USERNAME` and `APP_BASIC_AUTH_PASSWORD`

Update the Schwab Developer app callback URL to exactly match the hosted `SCHWAB_CALLBACK_URL`. Render provides public HTTPS, so the app disables its local self-signed HTTPS server in production.

## Automatic Universe

The screener always scans a de-duped **S&P 500 + Nasdaq 100 + selected ETFs** universe. There is no user-managed stock-universe workflow in this version.

The checked-in universe is a safe last-known-good fallback. On startup, the server attempts to refresh the universe from FMP's S&P 500 and Nasdaq constituent endpoints if no valid cached universe exists. If FMP is unavailable, rate-limited, malformed, or incomplete, it falls back to public S&P 500 and Nasdaq 100 source pages. At the end of every month, it checks again and caches the refreshed symbol list in the configured database. If every live refresh source fails, the app keeps using the last cached list or the bundled fallback.

OpenAI API is not used for universe gathering in this version. The stock universe comes from FMP index constituent endpoints with deterministic public-source parsing and the bundled list as fallbacks. ETF candidates come from the curated or configured ETF list. Schwab remains the market-data source for screening.

## What It Evaluates

- Optionable stock or selected ETF
- Price above $20
- Stock beta >= 0.75
- Market cap >= $2B when Schwab provides market cap
- ETFs bypass beta, market-cap, sector, and single-company earnings requirements
- Stock liquidity requires current-day volume >= 1M and passes with either average share volume >= 1.5M or average dollar volume >= $300M; average share volume uses Schwab first, FMP profile second, and recent 20-session candle volume last
- A setups require the full bullish 8/21/34/55/89 EMA stack and the preferred 21-to-8 EMA entry pocket
- B setups may use the expanded trend path when the Daily 8 EMA is above the 21 EMA and price is between the 21 EMA and 1.5 ATR above it
- Selected timeframes: daily and weekly
- Daily squeeze dots and technical indicators use completed regular-session candles; the still-open current-session daily bar is excluded until 4:00 p.m. America/New_York, while the dashboard price can continue to show a newer live quote.
- At least 2 consecutive active Daily squeeze dots before expansion; 2-4 dots can qualify as a developing B setup, while 5+ dots establish a ready setup that remains visible until the squeeze fires
- Daily 20-period Squeeze histogram must be strictly above zero; both cyan (positive and rising) and blue (positive but falling) qualify
- Daily price between the 34 EMA and 8 EMA, or within 1 ATR above the 21 EMA, is eligible for the preferred A-entry zone; controlled extension up to 1.5 ATR above the 21 EMA remains valid but contributes fewer setup points
- Daily squeeze-dot count and a histogram above zero are compression gates; ATR contraction, Bollinger Band contraction, candle-range contraction, and whether positive momentum is improving remain context
- Weekly full-stack or 21-EMA proximity confirmation remains preferred; neutral Weekly structure can qualify only as B, while bearish Weekly structure is still rejected
- Weekly squeeze is bonus confirmation, not a requirement
- Bearish SPY/QQQ Daily structure is a macro caution that reduces the setup score and caps qualifying setups at B; it does not automatically reject an otherwise valid squeeze
- Independent layer statuses for market structure, institutional context, options context, macro regime, and Daily squeeze dots
- Institutional setup score from 0-100 across weighted setup factors: Daily structure, Daily squeeze momentum, compression quality, relative strength, sector strength, and catalyst safety
- Optional FMP Institutional Edge context uses Starter-accessible endpoint probing for financial scores, analyst grades/targets, insider data, and ETF data when available; unavailable endpoints are skipped neutrally and FMP context does not affect grading
- Optional QuantData Institutional Positioning overlay uses live options flow, options exposure (dealer gamma walls), dark-pool levels, max-pain pin risk, call open-interest change, and an IV Rank cross-check against Compression Quality strictly as a `Take`/`Avoid` confirmation/caution/veto layer; it never changes the technical grade or controls setup visibility
- Optional QuantData universe-level Gainers-Losers ranking reorders (does not filter) the per-scan symbol list once per scan so QuantData's per-symbol call budget is spent on names with real same-day movement first; it is a scan-ordering signal, not a scoring factor
- Sector strength uses S&P 500 GICS sector data when available, maps sectors to ETF proxies such as XLK/XLF/XLV, and compares that sector ETF against SPY
- ETF strength compares the ETF directly against SPY over the same 20-period window
- Catalyst safety uses the next earnings date for stocks; earnings within 14 days block the setup, earnings 15-29 days away are neutral caution, and earnings 30+ days away are bullish for A setups. ETFs are treated as not having single-company earnings catalyst risk.
- FMP fallback data can satisfy missing beta, market cap, sector, and next-earnings context when Schwab omits those values
- Liquid 14-180 DTE swing call candidates, with 14-90 DTE preferred, delta around 0.35-0.75, spread no wider than 15%, preferred spread at or below 10%, and at least 100 open interest or 25 contracts of volume

The automatic index universe is treated as prequalified if Schwab and FMP both omit market cap. If either provider supplies market cap below the configured threshold, the symbol is rejected.

Once a setup appears, the scanner records its squeeze lifecycle and keeps it in the results while the Daily squeeze remains active, even if momentum, entry location, setup score, or overlays later weaken. Manually saved setups follow the same rule: their payload and `Take`/`Avoid` mark continue to refresh, and they are removed automatically only after a later successful scan confirms the squeeze has released/ended (or when the user removes them). Provider-wide scan failures preserve the previous result cache and watchlist instead of replacing them with an empty snapshot.

Momentum follows the 20-period Squeeze histogram pipeline: price is measured against the average of the 20-bar high/low midpoint and 20-bar average close, then smoothed with a 20-bar least-squares linear regression curve. `momentumImproving` compares the current histogram bar with the immediately previous bar. Histogram state is reported as cyan, blue, red, or yellow from its sign and direction.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It requires both Bollinger Bands to sit inside the selected Keltner Channel width to classify compression as low, mid, or high; otherwise it reports released or none. This app is decision support only and does not place trades.
