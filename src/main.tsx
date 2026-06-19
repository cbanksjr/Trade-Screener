import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, BarChart3, CheckCircle2, Moon, Play, Sun, XCircle } from "lucide-react";
import { CandlestickSeries, ColorType, createChart, LineSeries, type CandlestickData, type LineData, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BrokerStatus, Candle, ChartDataResponse, ChartTimeframe, ScanResponse, ScanResult, Settings } from "../shared/types";
import "./styles.css";

const api = {
  async results(): Promise<Partial<ScanResponse>> {
    const response = await fetch("/api/results");
    return response.json();
  },
  async scan(): Promise<ScanResponse> {
    const response = await fetch("/api/scan", { method: "POST" });
    return response.json();
  },
  async scanStatus(): Promise<ScanResponse> {
    const response = await fetch("/api/scan/status");
    return response.json();
  },
  async brokerStatus(): Promise<BrokerStatus> {
    const response = await fetch("/api/schwab/status");
    return response.json();
  },
  async connectSchwab(): Promise<{ loginUrl: string }> {
    const response = await fetch("/api/schwab/login");
    return response.json();
  },
  async chart(symbol: string, timeframe: ChartTimeframe): Promise<ChartDataResponse> {
    const response = await fetch("/api/chart/" + encodeURIComponent(symbol) + "?timeframe=" + encodeURIComponent(timeframe));
    return response.json();
  }
};

const GRADE_ORDER = ["A", "B"] as const;
const CHART_TIMEFRAMES: Array<{ label: string; value: ChartTimeframe }> = [
  { label: "1W", value: "1w" },
  { label: "1D", value: "1d" },
  { label: "4H", value: "4h" },
  { label: "1H", value: "1h" },
  { label: "30M", value: "30m" }
];
type ThemeMode = "light" | "dark";

function App() {
  const [results, setResults] = React.useState<ScanResult[]>([]);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [selected, setSelected] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [brokerStatus, setBrokerStatus] = React.useState<BrokerStatus | null>(null);
  const [scanStatus, setScanStatus] = React.useState<string>("idle");
  const [theme, setTheme] = React.useState<ThemeMode>(() => localStorage.getItem("theme") === "dark" ? "dark" : "light");

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const schwabResult = params.get("schwab");
    const schwabMessage = params.get("message");

    if (schwabResult === "connected") setMessage("Schwab connected. You can run a live scan now.");
    if (schwabResult === "error" && schwabMessage) console.warn("Schwab connection did not complete:", schwabMessage);
    if (schwabResult) window.history.replaceState({}, document.title, window.location.pathname);

    api.results().then((data) => {
      applyScanResponse(data);
      api.brokerStatus().then((status) => {
        setBrokerStatus(status);
        if (status.ok && shouldRefresh(data)) void startRefresh(false);
      }).catch(() => {
        setBrokerStatus({
          configured: false,
          baseUrl: "",
          ok: false,
          checkedAt: new Date().toISOString(),
          message: "Unable to check Schwab status."
        });
      });
    });

  }, []);

  const active = results.find((item) => item.symbol === selected) ?? results[0];

  React.useEffect(() => {
    if (!loading && scanStatus !== "running") return;
    const interval = window.setInterval(() => {
      api.scanStatus().then((data) => {
        applyScanResponse(data);
        if (!data.isRefreshing) setLoading(false);
      }).catch(() => setLoading(false));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [loading, scanStatus]);

  function applyScanResponse(data: Partial<ScanResponse>) {
    const nextResults = sortResultsByGrade(data.results ?? []);
    setResults(nextResults);
    if (data.settings) setSettings(data.settings);
    setSelected((current) => current && nextResults.some((item) => item.symbol === current) ? current : nextResults[0]?.symbol ?? "");
    setScanStatus(data.scanStatus ?? "idle");
    setLoading(Boolean(data.isRefreshing));
  }

  function shouldRefresh(data: Partial<ScanResponse>) {
    if (data.isRefreshing) return false;
    if (!data.results?.length) return true;
    if (!data.nextRefreshAt) return true;
    return new Date(data.nextRefreshAt).getTime() <= Date.now();
  }

  async function startRefresh(showMessage: boolean) {
    const data = await api.scan();
    applyScanResponse(data);
    if (showMessage) setMessage(data.isRefreshing ? "Refresh started. Cached results will stay visible while Schwab updates." : "Results are already current.");
    api.brokerStatus().then(setBrokerStatus).catch(() => undefined);
  }

  async function runScan() {
    setLoading(true);
    setMessage("");
    try {
      await startRefresh(true);
    } finally {
      // Polling owns the final loading state while a refresh is running.
    }
  }

  async function connectSchwab() {
    const response = await api.connectSchwab();
    window.location.href = response.loginUrl;
  }

  return (
    <main className="app-shell">
      <section className="app-content">
        <header className="topbar">
          <div>
            <h1>Options Swing Screener</h1>
            <p>Automatic S&amp;P 500 + Nasdaq 100 screening for long squeeze-style setups.</p>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Toggle color mode">
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <BrokerBadge brokerStatus={brokerStatus} settings={settings} onConnect={connectSchwab} />
            <button className="primary" onClick={runScan} disabled={loading}>
              <Play size={18} />
              {loading ? "Scanning..." : "Run Scan"}
            </button>
          </div>
        </header>

        <section className="status-strip">
          <Stat icon={<Activity />} label="Scan" value={loading || scanStatus === "running" ? "REFRESHING" : scanStatus.toUpperCase()} />
          <Stat icon={<BarChart3 />} label="Symbols" value={String(results.length)} />
          <Stat icon={<CheckCircle2 />} label="Passing Universe" value={String(results.filter((item) => item.passesUniverse).length)} />
        </section>

        {message && <div className="notice">{message}</div>}

        <section className="workspace">
          <div className="panel list-panel">
            <div className="panel-head">
              <h2>Qualified Compression Candidates</h2>
              <span>{new Date().toLocaleDateString()}</span>
            </div>
            <div className="table scroll-list">
              {results.map((result) => (
                <ResultRow result={result} activeSymbol={active?.symbol} onSelect={setSelected} key={result.symbol} />
              ))}
            </div>
          </div>

          <div className="detail">
            {active ? <TickerDetail result={active} theme={theme} /> : <EmptyState runScan={runScan} />}
          </div>
        </section>
      </section>
    </main>
  );
}

function sortResultsByGrade(results: ScanResult[]): ScanResult[] {
  return [...results].sort((left, right) => {
    const gradeDelta = GRADE_ORDER.indexOf(left.grade) - GRADE_ORDER.indexOf(right.grade);
    if (gradeDelta !== 0) return gradeDelta;
    const leftDots = dailySqueezeDotCount(left) ?? -1;
    const rightDots = dailySqueezeDotCount(right) ?? -1;
    if (rightDots !== leftDots) return rightDots - leftDots;
    return left.symbol.localeCompare(right.symbol);
  });
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="stat">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BrokerBadge({ brokerStatus, settings, onConnect }: {
  brokerStatus: BrokerStatus | null;
  settings: Settings | null;
  onConnect: () => void;
}) {
  const needsLogin = brokerStatus?.needsLogin && settings?.hasBrokerCredentials;
  return (
    <button className={"broker-badge " + (brokerStatus?.ok ? "connected" : "")} onClick={needsLogin ? onConnect : undefined} disabled={!needsLogin}>
      <span />
      {brokerStatus?.ok ? "Connected" : needsLogin ? "Connect Schwab" : "Setup Needed"}
    </button>
  );
}

function ResultRow({ result, activeSymbol, onSelect }: {
  result: ScanResult;
  activeSymbol?: string;
  onSelect: (symbol: string) => void;
}) {
  return (
    <div className={"row " + (result.symbol === activeSymbol ? "active" : "")} onClick={() => onSelect(result.symbol)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onSelect(result.symbol);
    }} role="button" tabIndex={0}>
      <span className={"grade grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
      <span>
        <strong>{result.symbol}</strong>
        <small>{money(result.price)} · {result.longCallDecision} · Daily dots {dailySqueezeDotLabel(result)}</small>
      </span>
    </div>
  );
}

function TickerDetail({ result, theme }: { result: ScanResult; theme: ThemeMode }) {
  return (
    <>
      <section className="panel hero-panel">
        <div>
          <span className={"grade large grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
          <h2>{result.symbol}</h2>
          <p>{result.longCallDecision} · {money(result.price)} · {result.entryRecommendationType}</p>
        </div>
        <div className="indicator-grid">
          <Metric label="30m Sqz" value={timeframeSqueeze(result, "30m")} />
          <Metric label="1h Sqz" value={timeframeSqueeze(result, "1h")} />
          <Metric label="4h Sqz" value={timeframeSqueeze(result, "4h")} />
          <Metric label="Daily Sqz" value={timeframeSqueeze(result, "daily")} />
          <Metric label="Weekly Sqz" value={timeframeSqueeze(result, "weekly")} />
          <Metric label="Daily Dots" value={dailySqueezeDotLabel(result)} />
          <Metric label="Momentum" value={formatNumber(result.indicators.momentum)} />
          <Metric label="8 EMA" value={formatNumber(result.indicators.ema8)} />
          <Metric label="21 EMA" value={formatNumber(result.indicators.ema21)} />
          <Metric label="34 EMA" value={formatNumber(result.indicators.ema34)} />
          <Metric label="55 EMA" value={formatNumber(result.indicators.ema55)} />
          <Metric label="89 EMA" value={formatNumber(result.indicators.ema89)} />
          <Metric label="ATR" value={formatNumber(result.indicators.atr14)} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Setup Summary</h2>
          <span>{result.setupQuality} quality</span>
        </div>
        <div className="summary-grid">
          <Metric label="Alignment" value={result.multiTimeframeAlignmentSummary} />
          <Metric label="Weekly" value={result.weeklyContextSummary} />
          <Metric label="Relative Strength" value={result.relativeStrengthSummary} />
          <Metric label="Institutional" value={result.institutionalContextSummary} />
          <Metric label="Macro" value={result.macroRegimeSummary} />
        </div>
      </section>

      <section className="panel chart-panel">
        <ChartPanel result={result} theme={theme} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Layer Status</h2>
          <span>Independent evaluation</span>
        </div>
        <div className="rules">
          {result.layerEvaluations.map((layer) => (
            <div className="rule" key={layer.layer}>
              {layer.status === "Bullish" || layer.status === "Neutral" ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}
              <span>
                <strong>{layerLabel(layer.layer)}: {layer.status}</strong>
                <small>{layerDetail(result, layer)}</small>
              </span>
              <b>{layer.status}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Trade Plan</h2>
          <span>{result.entryRecommendationType}</span>
        </div>
        <div className="summary-grid">
          <Metric label="Entry Area" value={result.suggestedEntryArea} />
          <Metric label="Invalidation" value={result.invalidationLevel} />
          <Metric label="Stock Stop" value={moneyOrUnavailable(result.stockStopPrice)} />
          <Metric label="Target 1" value={moneyOrUnavailable(result.target1)} />
          <Metric label="Target 2" value={moneyOrUnavailable(result.target2)} />
          <Metric label="Alert" value={result.alertMessage} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recommended Calls</h2>
          <span>30-180 DTE swing calls</span>
        </div>
        <div className="contracts">
          {result.suggestedOptions.map((contract) => (
            <div className="contract" key={contract.symbol}>
              <strong>{contract.strike}{contract.optionType === "call" ? "C" : "P"} · {dateOrUnavailable(contract.expirationDate)}</strong>
              <span>Bid/Ask ${contract.bid.toFixed(2)} / ${contract.ask.toFixed(2)}</span>
              <span>DTE {contract.dte ?? "n/a"} · Delta {contract.delta?.toFixed(2) ?? "n/a"} · OI {contract.openInterest} · Vol {contract.volume} · Spread {contract.spreadPct.toFixed(1)}%</span>
              <b>{Math.round(contract.score)}</b>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function ChartPanel({ result, theme }: { result: ScanResult; theme: ThemeMode }) {
  const [timeframe, setTimeframe] = React.useState<ChartTimeframe>("1d");
  const [candles, setCandles] = React.useState<Candle[]>(result.candles);
  const fallbackCandlesRef = React.useRef(result.candles);

  React.useEffect(() => {
    fallbackCandlesRef.current = result.candles;
    setTimeframe("1d");
    setCandles(result.candles);
  }, [result.symbol]);

  React.useEffect(() => {
    let cancelled = false;
    api.chart(result.symbol, timeframe).then((data) => {
      if (cancelled) return;
      setCandles(data.candles.length ? data.candles : fallbackCandlesRef.current);
    }).catch((error) => {
      if (cancelled) return;
      console.warn("Chart timeframe could not be loaded:", error);
      setCandles(fallbackCandlesRef.current);
    });
    return () => {
      cancelled = true;
    };
  }, [result.symbol, timeframe]);

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        <div className="timeframe-tabs">
          {CHART_TIMEFRAMES.map((item) => (
            <button className={item.value === timeframe ? "active" : ""} key={item.value} onClick={() => setTimeframe(item.value)}>{item.label}</button>
          ))}
        </div>
      </div>
      <LightweightPriceChart candles={candles} theme={theme} />
    </div>
  );
}

function LightweightPriceChart({ candles, theme }: { candles: Candle[]; theme: ThemeMode }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = chartPalette(theme);
    const chartWidth = Math.max(1, container.clientWidth);
    const chartHeight = Math.max(1, container.clientHeight);

    const chart = createChart(container, {
      width: chartWidth,
      height: chartHeight,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        fontSize: 11,
        textColor: colors.text
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid }
      },
      rightPriceScale: { borderColor: colors.border, minimumWidth: 48 },
      timeScale: { borderColor: colors.border },
      localization: { priceFormatter: (price: number) => money(price) }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#14a06f",
      downColor: "#d15a5a",
      borderUpColor: "#14a06f",
      borderDownColor: "#d15a5a",
      wickUpColor: "#14a06f",
      wickDownColor: "#d15a5a"
    });
    const chartCandles = candles.map((candle): CandlestickData<Time> => ({
      time: toChartTime(candle.date),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    }));
    series.setData(chartCandles);
    const ema8Series = chart.addSeries(LineSeries, {
      color: colors.ema8,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "8 EMA"
    });
    const ema21Series = chart.addSeries(LineSeries, {
      color: colors.ema21,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "21 EMA"
    });
    const ema34Series = chart.addSeries(LineSeries, {
      color: colors.ema34,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "34 EMA"
    });
    const ema55Series = chart.addSeries(LineSeries, {
      color: colors.ema55,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "55 EMA"
    });
    const ema89Series = chart.addSeries(LineSeries, {
      color: colors.ema89,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "89 EMA"
    });
    ema8Series.setData(emaLineData(candles, 8));
    ema21Series.setData(emaLineData(candles, 21));
    ema34Series.setData(emaLineData(candles, 34));
    ema55Series.setData(emaLineData(candles, 55));
    ema89Series.setData(emaLineData(candles, 89));
    chart.timeScale().fitContent();
    const resizeObserver = new ResizeObserver(() => {
      chart.resize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight), true);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [candles, theme]);

  return <div className="lightweight-chart" ref={containerRef} />;
}

function chartPalette(theme: ThemeMode) {
  return theme === "dark"
    ? { background: "#121c22", text: "#99aab3", grid: "#273842", border: "#273842", ema8: "#20c997", ema21: "#6dcadd", ema34: "#f5b84b", ema55: "#e0a526", ema89: "#ef6b6b" }
    : { background: "#ffffff", text: "#667085", grid: "#e5eaf0", border: "#e5eaf0", ema8: "#047857", ema21: "#1d7a8c", ema34: "#d39b24", ema55: "#b98518", ema89: "#b64141" };
}

function toChartTime(value: string): Time {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value as Time;
  return Math.floor(new Date(value).getTime() / 1000) as UTCTimestamp;
}

function emaLineData(candles: Candle[], period: number): LineData<Time>[] {
  const multiplier = 2 / (period + 1);
  const output: LineData<Time>[] = [];
  let previous: number | undefined;
  candles.forEach((candle, index) => {
    previous = index === 0 || previous === undefined ? candle.close : candle.close * multiplier + previous * (1 - multiplier);
    if (index >= period - 1) {
      output.push({
        time: toChartTime(candle.date),
        value: Number(previous.toFixed(2))
      });
    }
  });
  return output;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function EmptyState({ runScan }: { runScan: () => void }) {
  return <button className="empty" onClick={runScan}>Run the first scan</button>;
}

function timeframeLabel(value: string | undefined): string {
  if (!value) return "Unavailable";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function timeframeSqueeze(result: ScanResult, timeframe: string): string {
  const status = result.squeezeStatusByTimeframe.find((item) => item.timeframe === timeframe);
  return status ? String(status.squeezeState) + " / " + timeframeLabel(status.bias) : "Unavailable";
}

function dailySqueezeDotCount(result: ScanResult): number | null {
  if (typeof result.dailySqueezeDotCount === "number") return result.dailySqueezeDotCount;
  if (result.maxScore === 5 && result.compressionQualityScore <= 30) return result.compressionQualityScore;
  return null;
}

function dailySqueezeDotLabel(result: ScanResult): string {
  const dots = dailySqueezeDotCount(result);
  return dots === null ? "Run scan for dot count" : dots + " active";
}

function layerLabel(layer: string): string {
  return layer === "Compression Quality" ? "Daily Squeeze Dots" : layer;
}

function layerDetail(result: ScanResult, layer: { layer: string; detail: string; status: string }): string {
  if (layer.layer !== "Compression Quality") return layer.detail;
  const dots = dailySqueezeDotCount(result);
  if (dots === null) return "Run scan for dot count.";
  if (layer.status === "Bearish") return "At least 5 consecutive active Daily squeeze dots are required; current count is " + dots + ". Intraday squeezes are bonus only.";
  return "Daily chart has " + dots + " consecutive active squeeze dots. Lower-timeframe squeezes are bonus only.";
}

function money(value: number): string {
  const hasFraction = Math.abs(value - Math.trunc(value)) > 0.000001;
  return "$" + formatNumber(value, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 6 : 0
  });
}

function moneyOrUnavailable(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? money(value) : "Unavailable";
}

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    ...options
  });
}

function dateOrUnavailable(value: string | undefined): string {
  if (!value) return "Unavailable";
  const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePrefix) return datePrefix;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
