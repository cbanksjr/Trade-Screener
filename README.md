# Local Options Swing Screener

A local web app for automatically screening optionable long-call compression candidates using A/B grade badges. It supports long setups against an automatic **S&P 500 + Nasdaq 100** universe.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173. Cached scan results load immediately when available; click **Run Scan** to start a background refresh while the cached dashboard stays visible.

The Dashboard only displays qualified `A` or `B` compression candidates. `A` means a strong long-call candidate with broad multi-timeframe bullish alignment, an active Daily squeeze, price inside the 1 ATR entry zone from the 21 EMA, and acceptable options liquidity. `B` means a moderate but still qualified long-call candidate. Watchlist and Avoid results are excluded from the visible candidate list.

The app can open immediately from saved results, but background refreshes need Schwab connected because the full default universe requires live quotes, fundamentals, history, and options data. The app keeps results fresh with a 15-minute background refresh cadence while connected. To use Schwab, create a Schwab Developer app, copy `.env.example` to `.env`, and add:

```bash
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:4173/api/schwab/callback
API_HTTPS=true
```

Then restart the dev server. The local API runs HTTPS by default for Schwab OAuth and will generate a local self-signed certificate in `certs/` the first time it starts. The app will show whether Schwab is connected. If credentials are present but no token is stored, click **Connect Schwab** and complete the OAuth login. Schwab must be configured with the exact same HTTPS callback URL as `.env`.

The scan uses Schwab for:

- `/marketdata/v1/quotes` for quote and fundamental market data
- `/marketdata/v1/pricehistory` for daily OHLCV history plus 15-minute intraday candles aggregated into 30m, 1h, and 4h context
- `/marketdata/v1/chains` for 7-90 DTE call chains with Greeks

The **See More** fundamentals page uses Schwab only. Fields Schwab does not return are omitted from the page instead of being filled by a supplemental provider.

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
- Selected timeframes: 15m, 30m, 1h, 4h, daily, and weekly
- Active Daily Squeeze Pro-style compression before expansion; intraday squeezes on 15m, 30m, 1h, or 4h are bonus confirmation only
- Entry proximity: current price must be above the 21 EMA and no more than 1 ATR above the 21 EMA
- Compression quality from Bollinger/Keltner squeeze state, ATR contraction, Bollinger Band contraction, candle-range contraction, and improving momentum
- Weekly chart context as higher-timeframe confirmation; weekly squeeze is bonus confirmation, not a requirement
- Independent layer statuses for market structure, institutional context, options context, macro regime, and compression quality
- Liquid call candidates in the preferred 7-21 DTE momentum or 30-90 DTE swing windows, with delta around 0.40-0.70

The automatic index universe is treated as prequalified if Schwab omits beta or market cap. If Schwab provides beta or market cap below the configured thresholds, the symbol is rejected.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It requires both Bollinger Bands to sit inside the selected Keltner Channel width to classify compression as low, mid, or high; otherwise it reports released or none. This app is decision support only and does not place trades.
