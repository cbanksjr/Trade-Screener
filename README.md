# Local Options Swing Screener

A local web app for automatically screening optionable swing-trade candidates using a transparent A+ through F grading model. It supports long and short setups against an automatic **S&P 500 + Nasdaq 100** universe.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173 and click **Run Scan**.

The app can open immediately, but the automatic scan needs Schwab connected because the full default universe requires live quotes, fundamentals, history, and options data. To use Schwab, create a Schwab Developer app, copy `.env.example` to `.env`, and add:

```bash
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:4173/api/schwab/callback
API_HTTPS=true
```

Then restart the dev server. The local API runs HTTPS by default for Schwab OAuth and will generate a local self-signed certificate in `certs/` the first time it starts. The Settings panel will show whether Schwab is connected. If credentials are present but no token is stored, click **Connect Schwab** and complete the OAuth login. Schwab must be configured with the exact same HTTPS callback URL as `.env`.

The scan uses Schwab for:

- `/marketdata/v1/quotes` for quote and fundamental market data
- `/marketdata/v1/pricehistory` for daily OHLCV history plus 30-minute intraday candles for 1h/4h confluence
- `/marketdata/v1/chains` for 30-180 DTE call and put chains with Greeks

## Automatic Universe

The screener always scans a de-duped **S&P 500 + Nasdaq 100** universe. There is no user-managed universe workflow in this version.

The checked-in universe is a safe last-known-good fallback. On startup, the server attempts to refresh the universe from public S&P 500 and Nasdaq 100 source pages if no valid cached public-source universe exists. At the end of every month, it checks those sources again and caches the refreshed symbol list in `data/screener.sqlite`. If a public-source refresh fails, the app keeps using the last cached list or the bundled fallback.

OpenAI API is not used for universe gathering in this version. The stock universe comes from deterministic public-source parsing plus the local cache, while Schwab remains the market-data source for screening.

## What It Scores

- Optionable stock
- Price above $20
- Beta >= 0.75 when Schwab provides beta
- Market cap >= $2B when Schwab provides market cap
- Average dollar volume >= $600M, from Schwab `average volume x last price` when available
- Long setup: 21 EMA above 50 EMA, price above the 21 EMA and within +1.25 ATR
- Short setup: 21 EMA below 50 EMA, price below the 21 EMA and within -1.25 ATR
- 1h and 4h confluence: bullish for longs, bearish for shorts, using 21/50 EMA alignment and price vs 50 EMA
- Squeeze Pro-style compression/release state
- Momentum histogram above zero for longs or below zero for shorts
- Liquid call candidates for longs or liquid put candidates for shorts

The automatic index universe is treated as prequalified if Schwab omits beta or market cap. If Schwab provides beta or market cap below the configured thresholds, the symbol is rejected.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It uses Bollinger Bands inside multiple Keltner Channel widths to classify compression as low, mid, high, released, or none. This app is decision support only and does not place trades.
