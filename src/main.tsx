import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Gauge,
  LayoutDashboard,
  ListFilter,
  Moon,
  Play,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  WalletCards,
  XCircle
} from "lucide-react";
import type { BrokerStatus, Candle, FundamentalFieldSources, LayerStatus, ScanResponse, ScanResult, Settings, WatchlistEntry } from "../shared/types";
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
  async watchlist(): Promise<WatchlistEntry[]> {
    const response = await fetch("/api/watchlist");
    return response.json();
  },
  async removeFromWatchlist(symbol: string): Promise<WatchlistEntry[]> {
    const response = await fetch("/api/watchlist/" + encodeURIComponent(symbol), { method: "DELETE" });
    return response.json();
  },
  async addToWatchlist(symbol: string): Promise<WatchlistEntry[]> {
    const response = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol })
    });
    return response.json();
  },
};

const GRADE_ORDER = ["A", "B", "C"] as const;
type ThemeMode = "light" | "dark";
type ViewMode = "scanner" | "watchlist";

function App() {
  const [results, setResults] = React.useState<ScanResult[]>([]);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [selected, setSelected] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [brokerStatus, setBrokerStatus] = React.useState<BrokerStatus | null>(null);
  const [scanStatus, setScanStatus] = React.useState<string>("idle");
  const [theme, setTheme] = React.useState<ThemeMode>(() => localStorage.getItem("theme") === "dark" ? "dark" : "light");
  const [view, setView] = React.useState<ViewMode>("scanner");
  const [watchlist, setWatchlist] = React.useState<WatchlistEntry[]>([]);

  function refreshWatchlist() {
    api.watchlist().then(setWatchlist).catch(() => undefined);
  }

  async function removeWatchlistSymbol(symbol: string) {
    const next = await api.removeFromWatchlist(symbol);
    setWatchlist(next);
  }

  async function addWatchlistSymbol(symbol: string) {
    const next = await api.addToWatchlist(symbol);
    setWatchlist(next);
  }

  React.useEffect(() => {
    refreshWatchlist();
  }, []);

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
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load scan results.");
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
    if (!data.isRefreshing) refreshWatchlist();
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start scan.");
      setLoading(false);
    }
  }

  async function connectSchwab() {
    const response = await api.connectSchwab();
    window.location.href = response.loginUrl;
  }

  const passingCount = results.filter((item) => item.passesUniverse).length;
  const takeCount = results.filter((item) => tradeMark(item) === "Take").length;
  const gradeACount = results.filter((item) => item.grade.startsWith("A")).length;
  const avoidCount = results.filter((item) => tradeMark(item) === "Avoid").length;

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="Primary navigation">
        <div className="brand-mark">
          <BarChart3 size={21} />
          <span>TS</span>
        </div>
        <nav>
          <button className={"nav-item " + (view === "scanner" ? "active" : "")} title="Scanner" onClick={() => setView("scanner")}><LayoutDashboard size={18} /></button>
          <button className={"nav-item " + (view === "watchlist" ? "active" : "")} title="Watchlists" onClick={() => setView("watchlist")}><WalletCards size={18} /></button>
        </nav>
      </aside>

      <section className="app-content">
        <header className="topbar">
          <div className="title-block">
            <span className="eyebrow">Analyst Workbench</span>
            <h1>Trade Screener</h1>
            <p>S&amp;P 500, Nasdaq 100, and ETF compression setups with institutional context.</p>
          </div>
          <div className="command-bar" role="search">
            <Search size={16} />
            <input value={selected} onChange={(event) => setSelected(event.target.value.toUpperCase())} placeholder="Search symbol" aria-label="Search symbol" />
            <span>/</span>
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

        <section className="control-strip" aria-label="Scan controls">
          <ToolbarChip icon={<SlidersHorizontal size={15} />} label="Mode" value="Auto Scan" />
          <ToolbarChip icon={<ListFilter size={15} />} label="Universe" value={`${results.length || "No"} symbols`} />
          <ToolbarChip icon={<CalendarClock size={15} />} label="Session" value={loading || scanStatus === "running" ? "Refreshing" : scanStatus} />
          <ToolbarChip icon={<ShieldCheck size={15} />} label="Broker" value={brokerStatus?.ok ? "Connected" : "Needs setup"} />
        </section>

        <section className="status-strip">
          <Stat icon={<Activity />} label="Scan Status" value={loading || scanStatus === "running" ? "REFRESHING" : scanStatus.toUpperCase()} tone="blue" />
          <Stat icon={<Gauge />} label="A Setups" value={String(gradeACount)} count={gradeACount} tone="good" />
          <Stat icon={<CheckCircle2 />} label="Actionable" value={String(takeCount)} count={takeCount} tone="good" />
          <Stat icon={<XCircle />} label="Avoid" value={String(avoidCount)} count={avoidCount} tone="risk" />
          <Stat icon={<BarChart3 />} label="Passing Universe" value={`${passingCount}/${results.length}`} tone="neutral" />
          <Stat icon={<WalletCards />} label="Watchlist" value={String(watchlist.length)} count={watchlist.length} tone="good" />
        </section>

        {message && <div className="notice">{message}</div>}

        {view === "watchlist" ? (
          <section className="workspace">
            <div className="panel list-panel">
              <div className="panel-head">
                <div>
                  <h2>Watchlist</h2>
                  <span>Symbols you've added from the scanner</span>
                </div>
                <span>{watchlist.length} symbol{watchlist.length === 1 ? "" : "s"}</span>
              </div>
              <div className="result-table scroll-list" role="table" aria-label="Watchlist">
                <div className="result-header" role="row">
                  <span>Symbol</span>
                  <span>Grade</span>
                  <span>Score</span>
                  <span>Added</span>
                  <span>Dots</span>
                  <span>Remove</span>
                </div>
                {watchlist.length === 0
                  ? <p className="empty-copy">No symbols on the watchlist yet. Run a scan to populate it.</p>
                  : watchlist.map((entry) => (
                      <WatchlistRow entry={entry} activeSymbol={active?.symbol} onSelect={(symbol) => { setSelected(symbol); setView("scanner"); }} onRemove={removeWatchlistSymbol} key={entry.symbol} />
                    ))}
              </div>
            </div>

            <div className="detail">
              {watchlist.length ? <TickerDetail result={watchlist.find((entry) => entry.symbol === active?.symbol)?.result ?? watchlist[0].result} /> : <EmptyState runScan={runScan} />}
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="panel list-panel">
              <div className="panel-head">
                <div>
                  <h2>Scan Results</h2>
                  <span>Ranked by setup score, grade, and squeeze quality</span>
                </div>
                <span>{new Date().toLocaleDateString()}</span>
              </div>
              <div className="result-table scroll-list" role="table" aria-label="Scan results">
                <div className="result-header" role="row">
                  <span>Symbol</span>
                  <span>Grade</span>
                  <span>Score</span>
                  <span>Entry</span>
                  <span>Dots</span>
                  <span>Mark</span>
                </div>
                {loading && results.length === 0
                  ? <ResultSkeleton />
                  : results.map((result) => (
                      <ResultRow result={result} activeSymbol={active?.symbol} onSelect={setSelected} key={result.symbol} />
                    ))}
              </div>
            </div>

            <div className="detail">
              {active ? (
                <TickerDetail
                  result={active}
                  onAddToWatchlist={addWatchlistSymbol}
                  isWatchlisted={watchlist.some((entry) => entry.symbol === active.symbol)}
                />
              ) : <EmptyState runScan={runScan} />}
            </div>
          </section>
        )}
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

function ToolbarChip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="toolbar-chip">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Stat({ icon, label, value, count, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; count?: number; tone?: "good" | "risk" | "blue" | "neutral" }) {
  const animated = useAnimatedNumber(count ?? 0);
  return (
    <div className={"stat stat-" + tone}>
      {icon}
      <span>{label}</span>
      <strong>{count === undefined ? value : String(Math.round(animated))}</strong>
    </div>
  );
}

function DemoFundamentalsBadge({ sources }: { sources?: FundamentalFieldSources }) {
  const demoFields = Object.entries(sources ?? {})
    .filter(([, source]) => source === "demo")
    .map(([field]) => field);
  if (!demoFields.length) return null;
  return (
    <span className="asset-badge demo-badge" title={"Mock data used for: " + demoFields.join(", ")}>
      Mock Data
    </span>
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
    <div className={"result-row " + (result.symbol === activeSymbol ? "active" : "")} onClick={() => onSelect(result.symbol)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onSelect(result.symbol);
    }} role="button" tabIndex={0}>
      <span className="symbol-wrap"><strong>{result.symbol}</strong>{result.assetType === "etf" ? <em>ETF</em> : null}<small>{money(result.price)}</small><Sparkline candles={result.candles} width={60} height={22} /></span>
      <span className={"grade grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
      <b>{setupScoreLabel(result)}</b>
      <span>{result.entryRecommendationType}</span>
      <span><SqueezeDotStrip count={dailySqueezeDotCount(result)} /></span>
      <span className={"decision " + (tradeMark(result) === "Take" ? "take" : "avoid")}>{tradeMark(result)}</span>
    </div>
  );
}

function WatchlistRow({ entry, activeSymbol, onSelect, onRemove }: {
  entry: WatchlistEntry;
  activeSymbol?: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const result = entry.result;
  return (
    <div className={"result-row " + (entry.symbol === activeSymbol ? "active" : "")} onClick={() => onSelect(entry.symbol)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onSelect(entry.symbol);
    }} role="button" tabIndex={0}>
      <span className="symbol-wrap"><strong>{result.symbol}</strong>{result.assetType === "etf" ? <em>ETF</em> : null}<small>{money(result.price)}</small><Sparkline candles={result.candles} width={60} height={22} /></span>
      <span className={"grade grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
      <b>{setupScoreLabel(result)}</b>
      <span>{addedAtLabel(entry.addedAt)}</span>
      <span><SqueezeDotStrip count={dailySqueezeDotCount(result)} /></span>
      <button className="icon-button" title={"Remove " + entry.symbol + " from watchlist"} onClick={(event) => { event.stopPropagation(); onRemove(entry.symbol); }}>
        <XCircle size={16} />
      </button>
    </div>
  );
}

function addedAtLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString() : "Unknown";
}

function TickerDetail({ result, onAddToWatchlist, isWatchlisted }: {
  result: ScanResult;
  onAddToWatchlist?: (symbol: string) => void;
  isWatchlisted?: boolean;
}) {
  return (
    <>
      <section className="panel hero-panel">
        <div className="hero-identity">
          <span className={"grade large grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
          <div>
            <span className="eyebrow">Selected Setup</span>
            <h2>{result.symbol} {result.assetType === "etf" ? <span className="asset-badge">ETF</span> : null} <DemoFundamentalsBadge sources={result.fundamentalSources} /></h2>
            <p>{setupTradeLabel(result)} · {money(result.price)} · {result.entryRecommendationType}</p>
            {onAddToWatchlist ? (
              <button className="primary watchlist-button" onClick={() => onAddToWatchlist(result.symbol)} disabled={isWatchlisted}>
                <WalletCards size={16} />
                {isWatchlisted ? "On Watchlist" : "Add to Watchlist"}
              </button>
            ) : null}
          </div>
        </div>
        {(typeof result.setupScore === "number" || result.candles?.length) ? (
          <div className="hero-viz">
            {typeof result.setupScore === "number" ? <RadialGauge value={result.setupScore} label="Setup Score" /> : null}
            {result.candles?.length ? (
              <div className="hero-spark">
                <span className="eyebrow">Price Trend</span>
                <Sparkline candles={result.candles} width={340} height={72} />
                <small>{result.candles.length}-bar close</small>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="summary-grid compact-metrics">
          <Metric label="Setup Score" value={setupScoreLabel(result)} />
          <Metric label="Next Earnings" value={nextEarningsLabel(result)} />
          <Metric label="Momentum" value={momentumLabel(result)} />
          <Metric label="Daily Sqz" value={timeframeSqueeze(result, "daily")} />
          <Metric label="Weekly Sqz" value={timeframeSqueeze(result, "weekly")} />
          <Metric label="Daily Dots" value={dailySqueezeDotLabel(result)} />
          <Metric label="Today Vol" value={shareVolumeLabel(result.currentVolume)} />
          <Metric label="ATR" value={formatNumber(result.indicators.atr14)} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Grade Rationale</h2>
            <span>Technical setup with institutional overlays</span>
          </div>
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
              <div>
                <h3>Institutional Positioning</h3>
                <span>{positioningStatusLabel(result.institutionalPositioningStatus)} · {positioningScoreLabel(result)}</span>
              </div>
            </div>
            <div className="summary-grid">
              <Metric label="Options Flow" value={signalLabel(result.optionsFlowSignal)} />
              <Metric label="Options Exposure" value={signalLabel(result.optionsExposureSignal)} />
              <Metric label="Dark Pool" value={signalLabel(result.darkPoolSignal)} />
              <Metric label="Max Pain" value={signalLabel(result.maxPainSignal)} />
              <Metric label="OI Change" value={signalLabel(result.openInterestChangeSignal)} />
              <Metric label="IV Rank" value={signalLabel(result.ivRankSignal)} />
              <Metric label="Grade" value={result.grade} />
            </div>
            {result.institutionalPromotionApplied ? (
              <div className="grade-cap take-mark">
                <strong>Grade Promoted</strong>
                <span>QuantData confluence promoted this setup from {result.gradeBeforeQuantData} to {result.finalGrade}.</span>
              </div>
            ) : null}
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
                <div className="factor-foot">
                  <BarMeter value={Math.max(0, factor.contribution)} max={maxFactorContribution(result.institutionalFactors)} />
                  <b>{formatNumber(factor.contribution, { maximumFractionDigits: 1 })} pts</b>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">Run scan for setup score.</p>
        )}
        {(result.institutionalEdgeFactors?.length || result.institutionalEdgeWarnings?.length) ? (
          <div className="edge-section">
            <div className="panel-head compact">
              <div>
                <h3>Institutional Edge</h3>
                <span>{displayStatus(result.institutionalEdgeStatus)} · Context only</span>
              </div>
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
          <div>
            <h2>Layer Status</h2>
            <span>Independent evaluation</span>
          </div>
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
          <div>
            <h2>Trade Plan</h2>
            <span>Entry, invalidation, and targets</span>
          </div>
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
          <div>
            <h2>Recommended Contract</h2>
            <span>14-180 DTE swing calls</span>
          </div>
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

function useAnimatedNumber(target: number, duration = 700): number {
  const [display, setDisplay] = React.useState(target);
  const fromRef = React.useRef(target);
  React.useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    if (reduce || from === target || !Number.isFinite(target)) {
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (target - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}

function Sparkline({ candles, width = 96, height = 28 }: { candles?: Candle[]; width?: number; height?: number }) {
  const gradientId = React.useId();
  const series = (candles ?? []).map((candle) => candle.close).filter((value) => Number.isFinite(value)).slice(-48);
  if (series.length < 2) return <span className="spark-empty" aria-hidden="true" />;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = width / (series.length - 1);
  const points = series.map((value, index) => [index * stepX, height - ((value - min) / span) * height] as const);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `M0,${height} ${points.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} L${width},${height} Z`;
  const up = series[series.length - 1] >= series[0];
  const stroke = up ? "var(--spark-up)" : "var(--spark-down)";
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none" role="img" aria-label={up ? "price trend up" : "price trend down"}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RadialGauge({ value, label, size = 118 }: { value: number; label?: string; size?: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const animated = useAnimatedNumber(clamped, 900);
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, animated)) / 100) * circumference;
  const color = clamped >= 67 ? "var(--accent)" : clamped >= 34 ? "var(--warning)" : "var(--danger)";
  const center = size / 2;
  return (
    <div className="gauge" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label ?? "Score"} ${Math.round(clamped)} of 100`}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--gauge-track)" strokeWidth={stroke} />
        <circle cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${dash.toFixed(2)} ${circumference.toFixed(2)}`} transform={`rotate(-90 ${center} ${center})`} />
      </svg>
      <div className="gauge-center">
        <strong>{Math.round(animated)}</strong>
        {label ? <span>{label}</span> : null}
      </div>
    </div>
  );
}

function SqueezeDotStrip({ count, max = 5 }: { count: number | null; max?: number }) {
  if (count === null) return <span className="dot-empty">Run scan</span>;
  const filled = Math.max(0, Math.min(max, count));
  return (
    <span className="dot-strip" role="img" aria-label={`${count} active squeeze dots`}>
      {Array.from({ length: max }).map((_, index) => (
        <i key={index} className={"sq-dot" + (index < filled ? " on" : "")} />
      ))}
      <small>{count}</small>
    </span>
  );
}

function BarMeter({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const tone = pct >= 66 ? "good" : pct >= 33 ? "warn" : "low";
  return (
    <span className={"bar-meter bar-" + tone} role="img" aria-label={`${value} of ${max}`}>
      <i style={{ width: pct.toFixed(1) + "%" }} />
    </span>
  );
}

function maxFactorContribution(factors: ScanResult["institutionalFactors"]): number {
  return Math.max(1, ...factors.map((factor) => Math.max(0, factor.contribution)));
}

function ResultSkeleton() {
  return (
    <>
      {Array.from({ length: 7 }).map((_, index) => (
        <div className="result-row skeleton-row" key={index} aria-hidden="true">
          <span className="skeleton-bar" style={{ width: "70%" }} />
          <span className="skeleton-bar" style={{ width: "60%" }} />
          <span className="skeleton-bar" style={{ width: "50%" }} />
          <span className="skeleton-bar" style={{ width: "80%" }} />
          <span className="skeleton-bar" style={{ width: "55%" }} />
          <span className="skeleton-bar" style={{ width: "45%" }} />
        </div>
      ))}
    </>
  );
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
  return dots === null ? "Run scan" : dots + " active";
}

function setupScoreValue(result: ScanResult): number {
  return typeof result.setupScore === "number" ? result.setupScore : 0;
}

function setupScoreLabel(result: ScanResult): string {
  return typeof result.setupScore === "number" ? formatNumber(result.setupScore, { maximumFractionDigits: 0 }) + "/100" : "Run scan";
}

function nextEarningsLabel(result: ScanResult): string {
  if (result.assetType === "etf") return "N/A";
  if (!result.nextEarningsDate) return "Unavailable";
  return result.nextEarningsDate + (typeof result.daysUntilNextEarnings === "number" ? " · " + result.daysUntilNextEarnings + "d" : "");
}

function shareVolumeLabel(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value >= 1_000_000) return formatNumber(value / 1_000_000, { maximumFractionDigits: 1 }) + "M";
  if (value >= 1_000) return formatNumber(value / 1_000, { maximumFractionDigits: 0 }) + "K";
  return formatNumber(value, { maximumFractionDigits: 0 });
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
