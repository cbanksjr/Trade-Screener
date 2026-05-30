# Local Options Swing Screener

A local web app for screening optionable swing-trade candidates using a transparent A+ through F grading model.

## Run It

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://127.0.0.1:5173 and click **Run Scan**.

The app works immediately with demo data. To use Tradier, copy `.env.example` to `.env` and add:

```bash
TRADIER_TOKEN=your_token_here
```

Then restart the dev server. The Settings panel will show whether Tradier is connected. The scan uses Tradier for:

- `/markets/quotes` for current price checks
- `/markets/history` for daily OHLCV history
- `/markets/options/expirations` for eligible option expirations
- `/markets/options/chains` for call contracts and Greeks

If Tradier is missing, rate-limited, or returns incomplete data, the dashboard shows warnings. In Universe mode with a live Tradier token, the app prefers real Tradier data and does not use demo contracts to qualify candidates.

## What It Scores

- Optionable stock
- Price above $20
- Beta and market cap are treated as prequalified by your uploaded watchlist
- Average dollar volume >= $600M, from Tradier `average_volume × last price` when available
- 21 EMA above 50 EMA
- Price within 1 ATR of the 21 EMA
- Squeeze Pro-style compression/release state
- Momentum histogram above zero
- Liquid call candidates

## Watchlist CSV

The Settings panel supports CSV import for the starting universe. Your uploaded watchlist is assumed to have already handled beta and market cap screening, so only a symbol/ticker column is required.

Minimal format:

```csv
Symbol
AAPL
MSFT
NVDA
```

The importer also accepts optional columns like `Ticker`, `Beta`, `Market Cap`, `Price`, and `Avg Volume`. If `avg_dollar_volume_20d` is missing but `Price` and `Avg Volume` are present, the app stores that calculated dollar volume, but Tradier remains the preferred source during live scans.

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

Tab-separated Thinkorswim exports also work, including headers like `Mark`, `Market Cap`, and `Avg Vol`.

Imported watchlist rows are stored in `data/screener.sqlite`.

After importing a larger CSV, the app switches to **Universe** mode and starts a scan automatically. In Universe mode the scanner no longer limits itself to the starter watchlist. It:

- Starts from every imported watchlist symbol
- Uses Tradier batch quotes to prefilter price and average dollar volume
- Uses Tradier daily candles to calculate EMA, ATR, squeeze state, and momentum
- Checks optionability through call contracts
- Scores the squeeze/trend checklist
- Shows only candidates that pass the active checklist and avoid weak `D/F` grades

Use **Watchlist** mode when you only want to scan hand-picked symbols.

## Notes

The squeeze logic is Squeeze Pro-style, not a licensed/proprietary clone. It uses Bollinger Bands inside multiple Keltner Channel widths to classify compression as low, mid, high, released, or none.
