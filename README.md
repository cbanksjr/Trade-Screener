# Local Options Swing Screener

A local web app for automatically screening optionable long-call compression candidates using A/B grade badges. It supports long setups against an automatic **S&P 500 + Nasdaq 100 + selected ETFs** universe.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173. Cached scan results load immediately when available; click **Run Scan** to start a background refresh while the cached dashboard stays visible.

The Dashboard only displays qualified `A` or `B` compression candidates with bullish Weekly context. `A` means a setup score of `90-100` with all hard gates satisfied. `B` means a setup score of `80-89` that still passes the trade-safety gates. `C` setups at `79` or below, Watchlist, Avoid, and non-bullish Weekly context results are excluded from the visible candidate list.

The app can open immediately from saved results, but background refreshes need Schwab connected because the full default universe requires live quotes, fundamentals, history, and options data. The app keeps results fresh with a 15-minute background refresh cadence while connected. To use Schwab, create a Schwab Developer app, copy `.env.example` to `.env`, and add:

```bash
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:4173/api/schwab/callback
API_HTTPS=true
FMP_API_KEY=your_fmp_key_here
```

Then restart the dev server. The local API runs HTTPS by default for Schwab OAuth and will generate a local self-signed certificate in `certs/` the first time it starts. The app will show whether Schwab is connected. If credentials are present but no token is stored, click **Connect Schwab** and complete the OAuth login. Schwab must be configured with the exact same HTTPS callback URL as `.env`.

The scan uses Schwab for:

- `/marketdata/v1/quotes` for quote and fundamental market data
- `/marketdata/v1/pricehistory` for daily OHLCV history and weekly context aggregated from daily candles
- `/marketdata/v1/chains` for 30-180 DTE swing call chains with Greeks

Financial Modeling Prep can be used for index universe refreshes and as a cached fallback when Schwab omits core institutional fields. Add `FMP_API_KEY` to `.env` or deployment secrets. The app keeps Schwab as primary for market data, then uses FMP to refresh the default universe and fill missing beta, market cap, sector, and next earnings date. Fallback results are cached for 24 hours and live FMP calls are capped by `FMP_MAX_CALLS_PER_SCAN`, default `1000`, to protect API limits.

FMP can also add a Starter-safe Institutional Edge overlay after a symbol already passes the core scan. It probes each optional endpoint with your API key, caches availability for `FMP_INSTITUTIONAL_EDGE_PROBE_TTL_HOURS` hours, and skips endpoints that return plan, permission, malformed entitlement, or rate-limit responses. Unavailable endpoint data is neutral and does not reduce a candidate. Available bullish edge data can add up to `+5` setup-score points; clearly bearish edge data can subtract up to `-10` and cap an A at B. Configure it with `FMP_INSTITUTIONAL_EDGE_ENABLED=true`, `FMP_STARTER_SAFE_MODE=true`, and `FMP_INSTITUTIONAL_EDGE_MAX_CALLS_PER_SCAN=250`.

The scanner includes a curated ETF list by default: `SPY`, `QQQ`, `DIA`, `IWM`, `SMH`, `XLK`, `XLF`, `XLV`, `XLE`, `XLY`, `XLI`, `XLC`, `XLP`, `XLU`, `XLB`, and `XLRE`. To override that list, set `ETF_SYMBOLS` to a comma-separated list such as `ETF_SYMBOLS=SPY,QQQ,SMH`.

## Hosting

For a hosted private deployment, use **Supabase Free Postgres** for persistence and a **Render Free Web Service** for the app. SQLite remains the local fallback when `DATABASE_URL` is not set, but hosted deployments should use Supabase so scan results, Schwab OAuth tokens, and cached universe data survive redeploys.

Render Free web services can sleep after inactivity. The app is built around that tradeoff: cached results load first after wake-up, and fresh scans run when you open the app or click **Run Scan**. The scheduled 15-minute refresh only runs while the Render service is awake.

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

Update the Schwab Developer app callback URL to exactly match the hosted `SCHWAB_CALLBACK_URL`. Render provides public HTTPS, so the app disables its local self-signed HTTPS server in production.

## Automatic Universe

The screener always scans a de-duped **S&P 500 + Nasdaq 100 + selected ETFs** universe. There is no user-managed stock-universe workflow in this version.

The checked-in universe is a safe last-known-good fallback. On startup, the server attempts to refresh the universe from FMP's S&P 500 and Nasdaq constituent endpoints if no valid cached universe exists. If FMP is unavailable, rate-limited, malformed, or incomplete, it falls back to public S&P 500 and Nasdaq 100 source pages. At the end of every month, it checks again and caches the refreshed symbol list in the configured database. If every live refresh source fails, the app keeps using the last cached list or the bundled fallback.

OpenAI API is not used for universe gathering in this version. The stock universe comes from FMP index constituent endpoints with deterministic public-source parsing and the bundled list as fallbacks. ETF candidates come from the curated or configured ETF list. Schwab remains the market-data source for screening.

## What It Evaluates

- Optionable stock or selected ETF
- Price above $20
- Beta >= 0.75 when Schwab provides beta
- Market cap >= $2B when Schwab provides market cap
- ETFs bypass beta, market-cap, sector, and single-company earnings requirements
- Average dollar volume >= $300M, from Schwab `average volume x last price` when available
- Long setup: price above the 8, 21, 50, and 100 EMAs with a positive EMA stack
- Selected timeframes: daily and weekly
- At least 5 consecutive active Daily squeeze dots before expansion
- Daily entry proximity: current price must be at least 0.1% above the 50 EMA and at least 0.1% below the 8 EMA
- Daily squeeze-dot count is used as the compression gate; ATR contraction, Bollinger Band contraction, candle-range contraction, and improving momentum remain context only
- Bullish Weekly chart context as required higher-timeframe confirmation; weekly squeeze is bonus confirmation, not a requirement
- Independent layer statuses for market structure, institutional context, options context, macro regime, and Daily squeeze dots
- Institutional setup score from 0-100 across seven equal-weight factors: market regime, sector strength, relative strength, liquidity, price structure, volatility fit, and catalyst safety
- Optional FMP Institutional Edge overlay uses Starter-accessible endpoint probing for financial scores, analyst grades/targets, ownership/insider data, and ETF data when available; unavailable endpoints are skipped neutrally
- Sector strength uses S&P 500 GICS sector data when available, maps sectors to ETF proxies such as XLK/XLF/XLV, and compares that sector ETF against SPY
- ETF strength compares the ETF directly against SPY over the same 20-period window
- Catalyst safety uses the next earnings date for stocks; earnings within 14 days block the setup, earnings 15-29 days away are neutral caution, and earnings 30+ days away are bullish for A setups. ETFs are treated as not having single-company earnings catalyst risk.
- FMP fallback data can satisfy missing beta, market cap, sector, and next-earnings context when Schwab omits those values
- Liquid 30-180 DTE swing call candidates, with 30-90 DTE preferred when quality is comparable and delta around 0.40-0.70

The automatic index universe is treated as prequalified if Schwab and FMP both omit beta or market cap. If either provider supplies beta or market cap below the configured thresholds, the symbol is rejected.

Momentum is the current Daily Squeeze Momentum-style value. The app compares the latest close against a 20-period midpoint baseline, then marks `momentumImproving` true when the current value is higher than the same calculation from 5 Daily bars ago.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It requires both Bollinger Bands to sit inside the selected Keltner Channel width to classify compression as low, mid, or high; otherwise it reports released or none. This app is decision support only and does not place trades.
