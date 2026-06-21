# Local Options Swing Screener

A local web app for automatically screening optionable long-call compression candidates using A/B grade badges. It supports long setups against an automatic **S&P 500 + Nasdaq 100** universe.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173. Cached scan results load immediately when available; click **Run Scan** to start a background refresh while the cached dashboard stays visible.

The Dashboard only displays qualified `A` or `B` compression candidates. `A` means a strong long-call candidate with a qualified Daily squeeze setup, supportive Weekly context, daily price inside the 1 ATR entry zone from the 21 EMA, acceptable options liquidity, and complete institutional context. `B` means a moderate but still qualified long-call candidate. Missing sector or earnings data can cap an otherwise strong setup at `B`, but does not exclude it. Watchlist and Avoid results are excluded from the visible candidate list.

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

Financial Modeling Prep can be used as a cached fallback when Schwab omits core institutional fields. Add `FMP_API_KEY` to `.env` or deployment secrets. The app keeps Schwab as primary, then uses FMP only to fill missing beta, market cap, sector, and future earnings date. Fallback results are cached for 24 hours and live FMP calls are capped by `FMP_MAX_CALLS_PER_SCAN`, default `100`, to protect API limits.

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

The screener always scans a de-duped **S&P 500 + Nasdaq 100** universe. There is no user-managed universe workflow in this version.

The checked-in universe is a safe last-known-good fallback. On startup, the server attempts to refresh the universe from public S&P 500 and Nasdaq 100 source pages if no valid cached public-source universe exists. At the end of every month, it checks those sources again and caches the refreshed symbol list in the configured database. If a public-source refresh fails, the app keeps using the last cached list or the bundled fallback.

OpenAI API is not used for universe gathering in this version. The stock universe comes from deterministic public-source parsing plus the local cache, while Schwab remains the market-data source for screening.

## What It Evaluates

- Optionable stock
- Price above $20
- Beta >= 0.75 when Schwab provides beta
- Market cap >= $2B when Schwab provides market cap
- Average dollar volume >= $600M, from Schwab `average volume x last price` when available
- Long setup: price above the 8, 21, 34, 55, and 89 EMAs with a positive EMA stack
- Selected timeframes: daily and weekly
- At least 5 consecutive active Daily squeeze dots before expansion
- Daily entry proximity: current price must be above the Daily 21 EMA and no more than 1 ATR above it
- Daily squeeze-dot count is used as the compression gate; ATR contraction, Bollinger Band contraction, candle-range contraction, and improving momentum remain context only
- Weekly chart context as higher-timeframe confirmation; weekly squeeze is bonus confirmation, not a requirement
- Independent layer statuses for market structure, institutional context, options context, macro regime, and Daily squeeze dots
- Institutional setup score from 0-100 across eight equal-weight factors: market regime, sector strength, relative strength, liquidity, volume expansion, price structure, volatility fit, and catalyst safety
- Sector strength uses S&P 500 GICS sector data when available, maps sectors to ETF proxies such as XLK/XLF/XLV, and compares that sector ETF against SPY
- Catalyst safety uses Schwab earnings date when available; earnings inside the configured danger window block the setup, while unavailable earnings data caps A grades
- FMP fallback data can satisfy missing beta, market cap, sector, and earnings-date context when Schwab omits those values
- Liquid 30-180 DTE swing call candidates, with 30-90 DTE preferred when quality is comparable and delta around 0.40-0.70

The automatic index universe is treated as prequalified if Schwab and FMP both omit beta or market cap. If either provider supplies beta or market cap below the configured thresholds, the symbol is rejected.

Momentum is the current Daily Squeeze Momentum-style value. The app compares the latest close against a 20-period midpoint baseline, then marks `momentumImproving` true when the current value is higher than the same calculation from 5 Daily bars ago.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It requires both Bollinger Bands to sit inside the selected Keltner Channel width to classify compression as low, mid, or high; otherwise it reports released or none. This app is decision support only and does not place trades.
