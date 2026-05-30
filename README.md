# Local Options Swing Screener

A local web app for screening optionable swing-trade candidates using a transparent A+ through F grading model. It supports long and short setups and can scan a built-in stock universe without a CSV upload.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173 and click **Run Scan**.

The app can open immediately, but **Auto** scans need Schwab connected because the full default universe requires live quotes, fundamentals, history, and options data. To use Schwab, create a Schwab Developer app, copy `.env.example` to `.env`, and add:

```bash
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_CALLBACK_URL=https://127.0.0.1:4173/api/schwab/callback
API_HTTPS=true
```

Then restart the dev server. The local API runs HTTPS by default for Schwab OAuth and will generate a local self-signed certificate in `certs/` the first time it starts. The Settings panel will show whether Schwab is connected. If credentials are present but no token is stored, click **Connect Schwab** and complete the OAuth login. Schwab must be configured with the exact same HTTPS callback URL as `.env`.

The scan uses Schwab for:

- `/marketdata/v1/quotes` for quote and fundamental market data
- `/marketdata/v1/pricehistory` for daily OHLCV history
- `/marketdata/v1/chains` for 30-180 DTE call and put chains with Greeks

## Scan Modes

- **Auto** scans the bundled, de-duped **S&P 500 + Nasdaq 100** universe. No CSV is required.
- **Imported** scans symbols from an optional CSV import.
- **Watchlist** scans the manually typed symbols only.

The bundled Auto universe is stored in the codebase as a safe fallback. At the end of every month, the local server checks public S&P 500 and Nasdaq 100 pages for constituent changes and caches the refreshed symbol list in `data/screener.sqlite`. If that refresh fails, Auto mode keeps using the last cached list or the bundled fallback.

## What It Scores

- Optionable stock
- Price above $20
- Beta >= 0.75
- Market cap >= $2B
- Average dollar volume >= $600M, from Schwab `average volume x last price` when available
- Long setup: 21 EMA above 50 EMA, price above the 21 EMA and within +1 ATR
- Short setup: 21 EMA below 50 EMA, price below the 21 EMA and within -1 ATR
- Squeeze Pro-style compression/release state
- Momentum histogram above zero for longs or below zero for shorts
- Liquid call candidates for longs or liquid put candidates for shorts

In **Auto** mode, missing beta or market cap prevents a symbol from qualifying. In **Imported** mode, CSV rows can still act as a prequalified custom universe when those fields are missing.

## Optional CSV Import

The Settings panel still supports CSV import for a custom universe. A symbol/ticker column is required; beta, market cap, price, and average volume are optional.

Minimal format:

```csv
Symbol
AAPL
MSFT
NVDA
```

Thinkorswim watchlist/export files are supported too. Use exported columns such as:

```csv
Symbol,LAST,AVG_VOLUME
AAPL,200,50000000
```

Thinkorswim Watchlist Scanner exports with title/preamble rows also work. For example:

```csv
Watchlist Scanner

Results
Symbol,Description,Last,Net Chng,%Change,Volume,Bid,Ask,High,Low,EPS,Market Cap,Vol Index
MSFT,MICROSOFT CORP,416.03,-2.54,-0.61%,"30,398,049",413.92,414.03,419.77,413.02,16.79,"3,090,452 M",30.72%
```

Imported watchlist rows are stored in `data/screener.sqlite`.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It uses Bollinger Bands inside multiple Keltner Channel widths to classify compression as low, mid, high, released, or none. This app is decision support only and does not place trades.
