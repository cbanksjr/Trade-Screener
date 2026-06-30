import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, BarChart3, CheckCircle2, Moon, Play, Sun, XCircle } from "lucide-react";
import type { BrokerStatus, LayerStatus, ScanResponse, ScanResult, Settings } from "../shared/types";
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
};

const GRADE_ORDER = ["A", "B", "C"] as const;
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
    if (showMessage && !data.isRefreshing) setMessage("Results are already current.");
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
            <p>Automatic S&amp;P 500 + Nasdaq 100 + selected ETF screening for long squeeze-style setups.</p>
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
            {active ? <TickerDetail result={active} /> : <EmptyState runScan={runScan} />}
          </div>
        </section>
      </section>
    </main>
  );
}

function sortResultsByGrade(results: ScanResult[]): ScanResult[] {
  return [...results].sort((left, right) => {
    const scoreDelta = setupScoreValue(right) - setupScoreValue(left);
    if (scoreDelta !== 0) return scoreDelta;
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
    <div className={"candidate-card " + (result.symbol === activeSymbol ? "active" : "")} onClick={() => onSelect(result.symbol)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onSelect(result.symbol);
    }} role="button" tabIndex={0}>
      <div className="candidate-card-top">
        <span className={"grade grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
        <span className="symbol-wrap"><strong>{result.symbol}</strong>{result.assetType === "etf" ? <em>ETF</em> : null}</span>
        <b>{setupScoreLabel(result)}</b>
      </div>
      <div className="candidate-card-stats">
        <span>{money(result.price)}</span>
        <span>{dailySqueezeDotLabel(result)} dots</span>
      </div>
      <small>{setupTradeLabel(result)}</small>
    </div>
  );
}

function TickerDetail({ result }: { result: ScanResult }) {
  return (
    <>
      <section className="panel hero-panel">
        <div>
          <span className={"grade large grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
          <h2>{result.symbol} {result.assetType === "etf" ? <span className="asset-badge">ETF</span> : null}</h2>
          <p>{setupTradeLabel(result)} · {money(result.price)} · {result.entryRecommendationType}</p>
        </div>
        <div className="indicator-grid">
          <Metric label="Daily Sqz" value={timeframeSqueeze(result, "daily")} />
          <Metric label="Weekly Sqz" value={timeframeSqueeze(result, "weekly")} />
          <Metric label="Daily Dots" value={dailySqueezeDotLabel(result)} />
          <Metric label="Setup Score" value={setupScoreLabel(result)} />
          <Metric label="Momentum" value={momentumLabel(result)} />
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
          <h2>Why This Setup Grade</h2>
          <span>{setupScoreLabel(result)} · {displayStatus(result.setupScoreStatus)}</span>
        </div>
        {result.gradeCapReasons?.length ? (
          <div className="grade-cap">
            <strong>Why this setup is {result.grade}</strong>
            <span>{result.gradeCapReasons.join(" ")}</span>
          </div>
        ) : null}
        <div className={"grade-cap " + (tradeMark(result) === "Take" ? "take-mark" : "avoid-mark")}>
          <strong>Trade Mark: {tradeMark(result)}</strong>
          <span>{tradeMarkReasons(result).join(" ")}</span>
        </div>
        {result.institutionalPositioningStatus ? (
          <div className="edge-section">
            <div className="panel-head compact">
              <h3>Institutional Positioning</h3>
              <span>{positioningStatusLabel(result.institutionalPositioningStatus)} · {positioningScoreLabel(result)}</span>
            </div>
            <div className="summary-grid">
              <Metric label="Options Flow" value={signalLabel(result.optionsFlowSignal)} />
              <Metric label="Options Exposure" value={signalLabel(result.optionsExposureSignal)} />
              <Metric label="Dark Pool" value={signalLabel(result.darkPoolSignal)} />
              <Metric label="Final Grade" value={(result.gradeBeforeQuantData ? result.gradeBeforeQuantData + " to " : "") + (result.finalGrade ?? result.grade)} />
            </div>
            {result.flags?.length ? (
              <div className="flag-list">
                {result.flags.map((flag) => <span key={flag}>{flag}</span>)}
              </div>
            ) : null}
            {result.institutionalPositioningReason ? <p className="edge-note">{result.institutionalPositioningReason}</p> : null}
          </div>
        ) : null}
        {result.institutionalFactors?.length ? (
          <div className="factor-grid">
            {result.institutionalFactors.map((factor) => (
              <div className="factor-card" key={factor.name}>
                <span className={"status-pill " + statusClass(factor.status)}>{displayStatus(factor.status)}</span>
                <strong>{factor.name}</strong>
                <small>{factor.detail}</small>
                <b>{formatNumber(factor.contribution, { maximumFractionDigits: 1 })} pts</b>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">Run scan for setup score.</p>
        )}
        {(result.institutionalEdgeFactors?.length || result.institutionalEdgeWarnings?.length) ? (
          <div className="edge-section">
            <div className="panel-head compact">
              <h3>Institutional Edge</h3>
              <span>{displayStatus(result.institutionalEdgeStatus)} · Context only</span>
            </div>
            {result.institutionalEdgeFactors?.length ? (
              <div className="factor-grid">
                {result.institutionalEdgeFactors.map((factor) => (
                  <div className="factor-card" key={factor.name}>
                    <span className={"status-pill " + statusClass(factor.status)}>{displayStatus(factor.status)}</span>
                    <strong>{factor.name}</strong>
                    <small>{factor.detail}</small>
                    <b>Info</b>
                  </div>
                ))}
              </div>
            ) : null}
            {result.institutionalEdgeWarnings?.length ? (
              <p className="edge-note">{result.institutionalEdgeWarnings.join(" ")}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Layer Status</h2>
          <span>Independent evaluation</span>
        </div>
        <div className="rules">
          {result.layerEvaluations.map((layer) => (
            <div className="rule" key={layer.layer}>
              {displayStatus(layer.status) === "Avoid" ? <XCircle className="bad" /> : <CheckCircle2 className={statusClass(layer.status)} />}
              <span>
                <strong>{layerLabel(layer.layer)}: {displayStatus(layer.status)}</strong>
                <small>{layerDetail(result, layer)}</small>
              </span>
              <b className={"status-pill " + statusClass(layer.status)}>{displayStatus(layer.status)}</b>
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
          <span>14-180 DTE swing calls</span>
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

function setupScoreValue(result: ScanResult): number {
  return typeof result.setupScore === "number" ? result.setupScore : 0;
}

function setupScoreLabel(result: ScanResult): string {
  return typeof result.setupScore === "number" ? formatNumber(result.setupScore, { maximumFractionDigits: 0 }) + "/100" : "Run scan";
}

function tradeMark(result: ScanResult): "Take" | "Avoid" {
  if (result.tradeMark) return result.tradeMark;
  return result.longCallDecision === "Avoid" || result.longCallDecision === "Watchlist Candidate" ? "Avoid" : "Take";
}

function tradeMarkReasons(result: ScanResult): string[] {
  const reasons = result.tradeMarkReasons ?? [];
  return reasons.length ? reasons : tradeMark(result) === "Take" ? ["Setup is technically valid and no avoid overlay is active."] : ["One or more trade overlays recommends avoiding this setup."];
}

function setupTradeLabel(result: ScanResult): string {
  return result.grade + " Setup · " + tradeMark(result);
}

function momentumLabel(result: ScanResult): string {
  const color = result.indicators.momentumColor;
  return formatNumber(result.indicators.momentum) + (color ? " · " + color[0].toUpperCase() + color.slice(1) : "");
}

function displayStatus(status: LayerStatus | undefined): "Bullish" | "Neutral" | "Avoid" {
  return status === "Bullish" || status === "Neutral" ? status : "Avoid";
}

function statusClass(status: LayerStatus | undefined): string {
  return displayStatus(status) === "Bullish" ? "status-bullish" : displayStatus(status) === "Neutral" ? "status-neutral" : "status-avoid";
}

function signedAdjustment(value: number | undefined): string {
  const rounded = Math.round(value ?? 0);
  return (rounded > 0 ? "+" : "") + rounded + " pts";
}

function positioningScoreLabel(result: ScanResult): string {
  return typeof result.institutionalPositioningScore === "number" ? formatNumber(result.institutionalPositioningScore, { maximumFractionDigits: 0 }) + "/100" : "No score";
}

function positioningStatusLabel(status: ScanResult["institutionalPositioningStatus"]): string {
  if (status === "confirmed") return "Confirmed";
  if (status === "capped") return "Capped";
  if (status === "vetoed") return "Vetoed";
  return "Neutral";
}

function signalLabel(value: string | undefined): string {
  if (!value) return "Unavailable";
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function layerLabel(layer: string): string {
  return layer === "Compression Quality" ? "Daily Squeeze Dots" : layer;
}

function layerDetail(result: ScanResult, layer: { layer: string; detail: string; status: string }): string {
  if (layer.layer !== "Compression Quality") return layer.detail;
  const dots = dailySqueezeDotCount(result);
  if (dots === null) return "Run scan for dot count.";
  if (dots < 2) return "At least 2 consecutive active Daily squeeze dots are required; current count is " + dots + ".";
  if (dots < 5) return "Daily squeeze is developing with " + dots + " active dots; compression contributes fewer setup points.";
  return "Daily chart has " + dots + " consecutive active squeeze dots.";
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
