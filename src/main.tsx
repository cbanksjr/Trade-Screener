import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BarChart3,
  Bell,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Filter,
  Gauge,
  LayoutDashboard,
  Moon,
  Play,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  TrendingUp,
  WalletCards,
  XCircle,
} from "lucide-react";
import type { BrokerStatus, CandidateListResponse, CandidateSummary, FundamentalFieldSources, LayerStatus, LocalSessionSnapshot, ScanMetadata, ScanResponse, ScanResult, Settings, WatchlistEntry } from "../shared/types";
import { AUTO_REFRESH_INTERVAL_MS, isMarketRefreshWindow, isRefreshDue } from "../shared/refreshSchedule";
import { loadBrowserSession, saveBrowserSession } from "./browserCache";
import { CandlestickChart } from "./CandlestickChart";
import { normalizeChartCandles } from "./chartCandles";
import "./styles.css";

const api = {
  async results(): Promise<Partial<CandidateListResponse>> {
    return apiJson("/api/results");
  },
  async result(symbol: string): Promise<ScanResult> {
    return apiJson("/api/results/" + encodeURIComponent(symbol));
  },
  async scan(): Promise<CandidateListResponse> {
    return apiJson("/api/scan", { method: "POST" });
  },
  async scanStatus(): Promise<Partial<ScanResponse>> {
    return apiJson("/api/scan/status");
  },
  async session(): Promise<LocalSessionSnapshot> {
    return apiJson("/api/session");
  },
  async restoreSession(snapshot: LocalSessionSnapshot): Promise<LocalSessionSnapshot> {
    return apiJson("/api/session/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  },
  async brokerStatus(): Promise<BrokerStatus> {
    return apiJson("/api/schwab/status");
  },
  async connectSchwab(): Promise<{ loginUrl: string }> {
    return apiJson("/api/schwab/login");
  },
  async watchlist(): Promise<WatchlistEntry[]> {
    return apiJson("/api/watchlist");
  },
  async removeFromWatchlist(symbol: string): Promise<WatchlistEntry[]> {
    return apiJson("/api/watchlist/" + encodeURIComponent(symbol), { method: "DELETE" });
  },
  async addToWatchlist(symbol: string): Promise<WatchlistEntry[]> {
    return apiJson("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
  },
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed with status " + response.status + ".");
  return data as T;
}

const GRADE_ORDER = ["A", "B", "C"] as const;
const FILTERS = ["all", "take", "avoid", "grade-a"] as const;
type ThemeMode = "light" | "dark";
type ViewMode = "scanner" | "watchlist";
type ResultFilter = typeof FILTERS[number];

function initialTheme(): ThemeMode {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function App() {
  const [results, setResults] = React.useState<CandidateSummary[]>([]);
  const [resultDetails, setResultDetails] = React.useState<Record<string, ScanResult>>({});
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [selected, setSelected] = React.useState("");
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const [filter, setFilter] = React.useState<ResultFilter>("all");
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [brokerStatus, setBrokerStatus] = React.useState<BrokerStatus | null>(null);
  const [sessionMetadata, setSessionMetadata] = React.useState<ScanMetadata>({ scanStatus: "idle" });
  const scanStatus = sessionMetadata.scanStatus;
  const lastScanFinishedAt = sessionMetadata.lastScanFinishedAt;
  const [scanMode, setScanMode] = React.useState<LocalSessionSnapshot["mode"]>("demo");
  const [scanWarnings, setScanWarnings] = React.useState<string[]>([]);
  const [runtimeCache, setRuntimeCache] = React.useState<Record<string, unknown>>({});
  const [browserHydrated, setBrowserHydrated] = React.useState(false);
  const [theme, setTheme] = React.useState<ThemeMode>(initialTheme);
  const [view, setView] = React.useState<ViewMode>("scanner");
  const [watchlist, setWatchlist] = React.useState<WatchlistEntry[]>([]);
  const [watchlistBusy, setWatchlistBusy] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const schwabResult = params.get("schwab");
    const schwabMessage = params.get("message");
    if (schwabResult === "connected") setMessage("Schwab connected. You can run a live scan now.");
    if (schwabResult === "error" && schwabMessage) console.warn("Schwab connection did not complete:", schwabMessage);
    if (schwabResult) window.history.replaceState({}, document.title, window.location.pathname);

    let cancelled = false;
    void (async () => {
      const cached = await loadBrowserSession();
      if (cancelled) return;
      if (cached) applyLocalSessionSnapshot(cached);
      try {
        const serverSnapshot = await api.session();
        const serverHasState = Boolean(serverSnapshot.results.length || serverSnapshot.watchlist.length || serverSnapshot.lastScanFinishedAt);
        const next = !serverHasState && cached && (cached.results.length || cached.watchlist.length || cached.lastScanFinishedAt)
          ? await api.restoreSession(cached)
          : serverSnapshot;
        if (!cancelled) applyLocalSessionSnapshot(next);
      } catch (error) {
        if (!cancelled && !cached) setMessage(error instanceof Error ? error.message : "Failed to load the local session.");
      } finally {
        if (!cancelled) setBrowserHydrated(true);
      }
    })();
    void api.brokerStatus().then(setBrokerStatus).catch(() => {
      if (!cancelled) setBrokerStatus({ configured: false, baseUrl: "", ok: false, checkedAt: new Date().toISOString(), message: "Unable to check Schwab status." });
    });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    if (!browserHydrated || !settings) return;
    const timeout = window.setTimeout(() => {
      const snapshot: LocalSessionSnapshot = {
        ...sessionMetadata,
        mode: scanMode,
        results: Object.values(resultDetails),
        settings,
        warnings: scanWarnings,
        watchlist,
        runtimeCache,
        cachedAt: new Date().toISOString()
      };
      void saveBrowserSession(snapshot).catch((error) => console.warn("Unable to save local browser session:", error));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [browserHydrated, resultDetails, runtimeCache, scanMode, scanWarnings, sessionMetadata, settings, watchlist]);

  React.useEffect(() => {
    if (!loading && scanStatus !== "running") return;
    const interval = window.setInterval(() => {
      void api.scanStatus().then((data) => {
        applyScanResponse(data);
        if (!data.isRefreshing) {
          setLoading(false);
          void api.session().then(applyLocalSessionSnapshot).catch(() => undefined);
        }
      }).catch(() => setLoading(false));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [loading, scanStatus]);

  const lastMarketPollAt = React.useRef(0);
  // While the market is open, poll lightweight price overlays at most once every 15 minutes.
  // The browser retains the full scan snapshot; this read-only refresh only patches summary
  // prices and never clears candles, evidence, watchlist state, or trade-plan details.
  React.useEffect(() => {
    if (!brokerStatus?.ok) return;
    const pollLivePrices = () => {
      if (document.visibilityState !== "visible" || loading || scanStatus === "running") return;
      if (!isMarketRefreshWindow()) return;
      if (!isRefreshDue(lastMarketPollAt.current)) return;
      lastMarketPollAt.current = Date.now();
      void api.results().then((data) => applyScanResponse(data)).catch(() => undefined);
    };
    const interval = window.setInterval(pollLivePrices, AUTO_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollLivePrices);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", pollLivePrices);
    };
  }, [brokerStatus?.ok, loading, scanStatus]);

  function applyLocalSessionSnapshot(snapshot: LocalSessionSnapshot) {
    const details = Object.fromEntries(snapshot.results.map((result) => [result.symbol, result]));
    const nextResults = sortResultsByGrade(snapshot.results.filter((result) => result.grade !== "C"));
    setResultDetails(details);
    setResults(nextResults);
    setSettings(snapshot.settings);
    setWatchlist(snapshot.watchlist);
    setRuntimeCache(snapshot.runtimeCache ?? {});
    setScanMode(snapshot.mode);
    setScanWarnings(snapshot.warnings ?? []);
    setSessionMetadata({
      scanStatus: snapshot.scanStatus,
      lastScanStartedAt: snapshot.lastScanStartedAt,
      lastScanFinishedAt: snapshot.lastScanFinishedAt,
      lastScanFailedAt: snapshot.lastScanFailedAt,
      lastScanMode: snapshot.lastScanMode,
      lastScanWarnings: snapshot.lastScanWarnings,
      scanDiagnostics: snapshot.scanDiagnostics,
      nextRefreshAt: snapshot.nextRefreshAt,
      isRefreshing: snapshot.isRefreshing
    });
    setLoading(Boolean(snapshot.isRefreshing));
    setSelected((current) => current && nextResults.some((item) => item.symbol === current) ? current : nextResults[0]?.symbol ?? "");
  }

  function applyScanResponse(data: Partial<ScanResponse> | Partial<CandidateListResponse>) {
    const nextResults = data.results ? sortResultsByGrade(data.results.filter((result) => result.grade !== "C")) : undefined;
    if (nextResults) setResults(nextResults);
    if (data.settings) setSettings(data.settings);
    if (data.mode) setScanMode(data.mode);
    if (data.warnings) setScanWarnings(data.warnings);
    if (nextResults) setSelected((current) => current && nextResults.some((item) => item.symbol === current) ? current : nextResults[0]?.symbol ?? "");
    setSessionMetadata((current) => mergeScanMetadata(current, data));
    setLoading(Boolean(data.isRefreshing));
  }

  async function startRefresh(showMessage: boolean) {
    const data = await api.scan();
    applyScanResponse(data);
    if (showMessage && !data.isRefreshing) setMessage("Results are already current.");
    void api.brokerStatus().then(setBrokerStatus).catch(() => undefined);
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

  async function toggleWatchlist(symbol: string) {
    if (watchlistBusy) return;
    setWatchlistBusy(true);
    try {
      const exists = watchlist.some((entry) => entry.symbol === symbol);
      const next = exists ? await api.removeFromWatchlist(symbol) : await api.addToWatchlist(symbol);
      setWatchlist(next);
      if (view === "watchlist" && exists) setSelected(next[0]?.symbol ?? "");
    } finally {
      setWatchlistBusy(false);
    }
  }

  function changeView(nextView: ViewMode) {
    setView(nextView);
    setFilter("all");
    setQuery("");
    const nextSymbol = nextView === "scanner" ? results[0]?.symbol : watchlist[0]?.symbol;
    if (nextSymbol) setSelected(nextSymbol);
  }

  const passingCount = results.reduce((count, item) => count + (item.passesUniverse ? 1 : 0), 0);
  const takeCount = results.reduce((count, item) => count + (tradeMark(item) === "Take" ? 1 : 0), 0);
  const gradeACount = results.reduce((count, item) => count + (item.grade === "A" ? 1 : 0), 0);
  const avoidCount = results.length - takeCount;
  const sourceEntries = React.useMemo(
    () => view === "scanner"
      ? results.map((result) => ({ result }))
      : watchlist.map((entry) => ({ result: entry.result, addedAt: entry.addedAt })),
    [results, view, watchlist],
  );
  const normalizedQuery = deferredQuery.trim().toUpperCase();
  const visibleEntries = React.useMemo(() => sourceEntries.filter(({ result }) => {
    const matchesQuery = !normalizedQuery || result.symbol.includes(normalizedQuery) || result.companyName?.toUpperCase().includes(normalizedQuery);
    const matchesFilter = filter === "all" || (filter === "take" && tradeMark(result) === "Take") || (filter === "avoid" && tradeMark(result) === "Avoid") || (filter === "grade-a" && result.grade === "A");
    return matchesQuery && matchesFilter;
  }), [filter, normalizedQuery, sourceEntries]);
  React.useEffect(() => {
    if (visibleEntries.length && !visibleEntries.some(({ result }) => result.symbol === selected)) {
      setSelected(visibleEntries[0].result.symbol);
    }
  }, [selected, visibleEntries]);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const sourceResults = sourceEntries.map((entry) => entry.result);
  const selectedSummary = sourceResults.find((item) => item.symbol === selected) ?? sourceResults[0];
  React.useEffect(() => {
    if (view !== "scanner" || !selectedSummary) return;
    const controller = new AbortController();
    void api.result(selectedSummary.symbol).then((result) => {
      if (!controller.signal.aborted) setResultDetails((current) => ({ ...current, [result.symbol]: result }));
    }).catch((error) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Failed to load candidate details.");
    });
    return () => controller.abort();
  }, [selectedSummary?.symbol, selectedSummary?.price, selectedSummary?.lastUpdated, view]);
  const active = view === "watchlist"
    ? watchlist.find((entry) => entry.symbol === selectedSummary?.symbol)?.result ?? watchlist[0]?.result
    : selectedSummary ? resultDetails[selectedSummary.symbol] : undefined;
  const isWatchlisted = active ? watchlist.some((entry) => entry.symbol === active.symbol) : false;

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="Primary navigation">
        <div className="brand-mark"><TrendingUp size={18} /><strong>TS</strong></div>
        <nav>
          <RailButton label="Scanner" active={view === "scanner"} onClick={() => changeView("scanner")}><LayoutDashboard size={18} /></RailButton>
          <RailButton label="Watchlist" active={view === "watchlist"} onClick={() => changeView("watchlist")}><Bookmark size={18} /></RailButton>
          <RailButton label="Alerts"><Bell size={18} /></RailButton>
          <RailButton label="Analytics"><BarChart3 size={18} /></RailButton>
        </nav>
        <div className="rail-bottom">
          <RailButton label={theme === "dark" ? "Use light mode" : "Use dark mode"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </RailButton>
          <RailButton label="Settings"><SettingsIcon size={18} /></RailButton>
          <RailButton label="Help"><CircleHelp size={18} /></RailButton>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div className="title-group"><span>Analyst workbench</span><h1>Trade Screener</h1></div>
          <label className="search-box">
            <Search size={16} />
            <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const exact = sourceResults.find((item) => item.symbol === query.trim().toUpperCase());
              if (exact) setSelected(exact.symbol);
            }} placeholder="Search symbol" aria-label="Search symbol" />
            <kbd>/</kbd>
          </label>
          <div className="top-status">
            <BrokerBadge brokerStatus={brokerStatus} settings={settings} onConnect={connectSchwab} />
            <span className="freshness"><RefreshCw size={13} className={loading ? "spin" : ""} />{lastUpdatedLabel(lastScanFinishedAt, loading)}</span>
          </div>
          <button className="theme-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <button className="scan-button" onClick={runScan} disabled={loading}>
            {loading ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}{loading ? "Refreshing" : "Run Scan"}
          </button>
        </header>

        <section className="summary-bar" aria-label="Scan summary">
          <span><ShieldCheck size={15} />{scanStatusLabel(scanStatus, loading)}</span><i />
          <span><strong>{passingCount}</strong> passing</span>
          <span className="take-text"><strong>{takeCount}</strong> Take</span>
          <span className="a-text"><strong>{gradeACount}</strong> A setups</span>
          <span className="avoid-text"><strong>{avoidCount}</strong> Avoid</span>
          <span className="summary-note">S&amp;P 500 · Nasdaq 100 · ETFs</span>
        </section>

        {message ? <div className="notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="Dismiss message"><XCircle size={15} /></button></div> : null}

        <section className="workspace">
          <CandidatePanel
            entries={visibleEntries}
            view={view}
            filter={filter}
            onFilter={setFilter}
            activeSymbol={selectedSummary?.symbol}
            onSelect={setSelected}
            loading={loading && results.length === 0}
            counts={{ all: sourceEntries.length, take: view === "scanner" ? takeCount : sourceResults.filter((item) => tradeMark(item) === "Take").length, avoid: view === "scanner" ? avoidCount : sourceResults.filter((item) => tradeMark(item) === "Avoid").length, gradeA: view === "scanner" ? gradeACount : sourceResults.filter((item) => item.grade === "A").length }}
          />
          {active ? (
            <>
              <FocusPanel result={active} theme={theme} isWatchlisted={isWatchlisted} watchlistBusy={watchlistBusy} onToggleWatchlist={() => void toggleWatchlist(active.symbol)} />
              <EvidencePanel result={active} />
            </>
          ) : selectedSummary && view === "scanner" ? (
            <>
              <section className="focus-panel"><div className="no-results">Loading candidate details…</div></section>
              <section className="evidence-panel"><div className="no-results">Loading decision evidence…</div></section>
            </>
          ) : <EmptyState view={view} runScan={runScan} />}
        </section>
      </section>
    </main>
  );
}

function RailButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return <button className={`rail-button${active ? " active" : ""}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function CandidatePanel({ entries, view, filter, onFilter, activeSymbol, onSelect, loading, counts }: {
  entries: Array<{ result: CandidateSummary; addedAt?: string }>;
  view: ViewMode;
  filter: ResultFilter;
  onFilter: (filter: ResultFilter) => void;
  activeSymbol?: string;
  onSelect: (symbol: string) => void;
  loading: boolean;
  counts: { all: number; take: number; avoid: number; gradeA: number };
}) {
  return (
    <aside className="candidates-panel">
      <div className="section-heading">
        <div><span>{view === "scanner" ? "Shortlist" : "Saved setups"}</span><h2>{view === "scanner" ? "Candidates" : "Watchlist"} <em>{counts.all}</em></h2></div>
        <button className="icon-action" aria-label="Filter candidates"><Filter size={16} /></button>
      </div>
      <div className="filter-tabs" role="tablist" aria-label="Candidate filters">
        <FilterTab label="All" count={counts.all} value="all" active={filter === "all"} onFilter={onFilter} />
        <FilterTab label="Take" count={counts.take} value="take" active={filter === "take"} onFilter={onFilter} />
        <FilterTab label="Avoid" count={counts.avoid} value="avoid" active={filter === "avoid"} onFilter={onFilter} />
        <FilterTab label="A setups" count={counts.gradeA} value="grade-a" active={filter === "grade-a"} onFilter={onFilter} />
      </div>
      <div className="candidate-labels"><span>Symbol</span><span>Grade</span><span>Squeeze</span><span>Mark</span></div>
      <div className="candidate-list">
        {loading ? <ResultSkeleton /> : entries.map(({ result, addedAt }) => (
          <CandidateRow result={result} addedAt={addedAt} active={result.symbol === activeSymbol} onSelect={onSelect} key={result.symbol} />
        ))}
        {!loading && !entries.length ? <div className="no-results">{view === "watchlist" ? "No saved setups match this filter." : "No candidates match this filter."}</div> : null}
      </div>
      <footer><SlidersHorizontal size={13} />Sorted by setup score <span>{entries.length} shown</span></footer>
    </aside>
  );
}

function FilterTab({ label, count, value, active, onFilter }: { label: string; count: number; value: ResultFilter; active: boolean; onFilter: (filter: ResultFilter) => void }) {
  return <button className={active ? "active" : ""} onClick={() => onFilter(value)} role="tab" aria-selected={active}>{label}<small>{count}</small></button>;
}

const CandidateRow = React.memo(function CandidateRow({ result, addedAt, active, onSelect }: { result: CandidateSummary; addedAt?: string; active: boolean; onSelect: (symbol: string) => void }) {
  return (
    <button className={`candidate-row${active ? " selected" : ""}`} onClick={() => onSelect(result.symbol)} aria-pressed={active}>
      <span className="ticker"><strong>{result.symbol}{result.assetType === "etf" ? <em>ETF</em> : null}</strong><small>{money(result.price)}{addedAt ? ` · saved ${shortDate(addedAt)}` : ""}</small></span>
      <span className={`grade grade-${result.grade.toLowerCase()}`}>{result.grade}<small>{Math.round(result.setupScore)}</small></span>
      <SqueezeDotStrip count={dailySqueezeDotCount(result)} />
      <span className={`decision decision-${tradeMark(result).toLowerCase()}`}>{tradeMark(result)}</span>
    </button>
  );
});

function FocusPanel({ result, theme, isWatchlisted, watchlistBusy, onToggleWatchlist }: { result: ScanResult; theme: ThemeMode; isWatchlisted: boolean; watchlistBusy: boolean; onToggleWatchlist: () => void }) {
  const mark = tradeMark(result);
  const contract = result.recommendedOptionContract ?? result.suggestedOptions[0];
  return (
    <section className="focus-panel">
      <div className="setup-header">
        <div className="setup-identity">
          <span className={`grade-badge grade-${result.grade.toLowerCase()}`}>{result.grade}</span>
          <div><span>Selected setup</span><h2>{result.symbol} <small>{money(result.price)}</small></h2><p>{result.companyName ?? result.entryRecommendationType}</p><small className="price-as-of">{priceAsOfLabel(result.priceAsOf)}</small></div>
        </div>
        <div className="score-lockup"><span>Setup score</span><strong>{Math.round(result.setupScore)}<small>/100</small></strong></div>
        <div className={`mark-lockup mark-${mark.toLowerCase()}`}><span>Trade mark</span><strong>{mark}</strong></div>
        <button className={`watch-button${isWatchlisted ? " active" : ""}`} onClick={onToggleWatchlist} disabled={watchlistBusy} aria-pressed={isWatchlisted}>
          <Bookmark size={16} fill={isWatchlisted ? "currentColor" : "none"} />{isWatchlisted ? "Saved" : "Watch"}
        </button>
      </div>

      <div className={`decision-banner banner-${mark.toLowerCase()}`}>
        {mark === "Take" ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
        <div><strong>{result.entryRecommendationType}</strong><span>{tradeMarkReasons(result)[0]}</span></div>
        <small>{displayStatus(result.setupScoreStatus)} setup</small>
      </div>

      <section className="chart-section">
        <div className="section-heading compact">
          <div><span>Price structure</span><h3>Daily candlestick chart</h3><small className="chart-session">Completed daily bars · {lastCompletedBarLabel(result.candles, result.lastUpdated)}</small></div>
          <div className="chart-legend"><span><i className="ema-color" />8 EMA</span><span><i className="ema21-color" />21 EMA</span><span><i className="entry-color" />Entry</span><span><i className="risk-color" />Stop</span></div>
        </div>
        <CandlestickChart candles={result.candles} dataAsOf={result.lastUpdated} entryArea={result.suggestedEntryArea} livePrice={result.price} stopPrice={result.stockStopPrice} target1={result.target1} target2={result.target2} symbol={result.symbol} theme={theme} />
      </section>

      <section className="trade-plan">
        <div className="section-heading compact"><div><span>Execution</span><h3>Trade plan</h3></div><small>{result.recommendedDte ?? "14–180 DTE swing"}</small></div>
        <div className="plan-steps">
          <PlanStep number="1" label="Entry area" value={result.suggestedEntryArea} detail={result.entryRecommendationType} />
          <ChevronRight />
          <PlanStep number="2" label="Invalidation" value={result.invalidationLevel} detail={moneyOrUnavailable(result.stockStopPrice)} risk />
          <ChevronRight />
          <PlanStep number="3" label="Target 1" value={moneyOrUnavailable(result.target1)} detail="First scale-out" />
          <ChevronRight />
          <PlanStep number="4" label="Target 2" value={moneyOrUnavailable(result.target2)} detail="Measured upside" />
        </div>
      </section>

      {contract ? (
        <section className="contract-row">
          <div className="contract-icon"><Gauge size={18} /></div>
          <div><span>Recommended call</span><strong>{result.symbol} · {contract.strike}{contract.optionType === "call" ? "C" : "P"} · {dateOrUnavailable(contract.expirationDate)}</strong></div>
          <ContractMetric label="Bid / Ask" value={`$${contract.bid.toFixed(2)} / $${contract.ask.toFixed(2)}`} />
          <ContractMetric label="Delta" value={contract.delta?.toFixed(2) ?? "Unavailable"} />
          <ContractMetric label="Open interest" value={formatNumber(contract.openInterest, { maximumFractionDigits: 0 })} />
          <ContractMetric label="Spread" value={`${contract.spreadPct.toFixed(1)}%`} good={contract.spreadPct <= 10} />
          <span className="contract-score">{Math.round(contract.score)}</span>
        </section>
      ) : <div className="contract-empty">No liquid contract met the configured swing criteria.</div>}
    </section>
  );
}

function PlanStep({ number, label, value, detail, risk }: { number: string; label: string; value: string; detail: string; risk?: boolean }) {
  return <div className={risk ? "risk-step" : ""}><i>{number}</i><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function ContractMetric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div><span>{label}</span><strong className={good ? "good-text" : ""}>{value}</strong></div>;
}

function EvidencePanel({ result }: { result: ScanResult }) {
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({ technical: true, positioning: true });
  const mark = tradeMark(result);
  const gradeReason = result.gradeCapReasons?.join(" ") || (result.grade === "A" ? "The technical setup scored at least 90 with A-quality structure." : `The technical setup scored ${Math.round(result.setupScore)}, below the 90-point A threshold.`);
  const layerBullishCount = result.layerEvaluations.filter((layer) => displayStatus(layer.status) === "Bullish").length;
  const cautionCount = result.layerEvaluations.length - layerBullishCount + (result.daysUntilNextEarnings !== undefined && result.daysUntilNextEarnings < 30 ? 1 : 0);

  function toggle(section: string) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  return (
    <aside className="evidence-panel">
      <div className="section-heading evidence-heading"><div><span>Decision evidence</span><h2>Why {result.grade} · Why {mark}</h2></div><Activity size={18} /></div>
      <div className={`why-block why-${mark.toLowerCase()}`}><div><strong>Why grade {result.grade}</strong><small>Technical setup</small></div><p>{gradeReason}</p></div>
      <div className={`why-block why-${mark.toLowerCase()}`}><div><strong>Why {mark}</strong><small>Independent trade mark</small></div><p>{tradeMarkReasons(result).join(" ")}</p></div>

      <EvidenceSection title="Technical score" meta={setupScoreLabel(result)} open={Boolean(openSections.technical)} onToggle={() => toggle("technical")}>
        {result.institutionalFactors.length ? <div className="factor-list">{result.institutionalFactors.map((factor) => <FactorRow result={result} factor={factor} key={factor.name} />)}</div> : <p className="empty-copy">Run a scan to populate setup factors.</p>}
      </EvidenceSection>

      <EvidenceSection title="Schwab options positioning" meta={`${positioningScoreLabel(result)} · ${positioningAvailabilityLabel(result)}`} open={Boolean(openSections.positioning)} onToggle={() => toggle("positioning")}>
        <div className="signal-grid">
          <Signal label="Options activity" value={positioningSignalLabel("flow", result.optionsFlowSignal, result.optionsPositioningAvailability)} tone={signalTone(result.optionsFlowSignal)} />
          <Signal label="Gamma concentration" value={positioningSignalLabel("gamma", result.optionsExposureSignal, result.optionsPositioningAvailability)} tone={signalTone(result.optionsExposureSignal)} />
          <Signal label="Dark-pool data" value={positioningSignalLabel("darkPool", result.darkPoolSignal, result.optionsPositioningAvailability)} tone={signalTone(result.darkPoolSignal)} />
          <Signal label="OI confirmation" value={positioningSignalLabel("openInterest", result.openInterestChangeSignal, result.optionsPositioningAvailability)} tone={signalTone(result.openInterestChangeSignal)} />
          <Signal label="IV rank" value={positioningSignalLabel("ivRank", result.ivRankSignal, result.optionsPositioningAvailability)} tone={signalTone(result.ivRankSignal)} />
          <Signal label="Max pain" value={positioningSignalLabel("maxPain", result.maxPainSignal, result.optionsPositioningAvailability)} tone={signalTone(result.maxPainSignal)} />
        </div>
        {result.optionsPositioningReason ? <p className="section-note">{result.optionsPositioningReason}</p> : null}
        {result.flags?.length ? <div className="flag-list">{result.flags.map((flag) => <span key={flag}>{flag}</span>)}</div> : null}
      </EvidenceSection>

      <EvidenceSection title="Layer status" meta={`${layerBullishCount}/${result.layerEvaluations.length} bullish`} open={Boolean(openSections.layers)} onToggle={() => toggle("layers")}>
        <ul className="layer-list">{result.layerEvaluations.map((layer) => (
          <li key={layer.layer}>{displayStatus(layer.status) === "Bullish" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span><strong>{layerLabel(layer.layer)}</strong><small>{layerDetail(result, layer)}</small></span><b className={statusClass(layer.status)}>{displayStatus(layer.status)}</b></li>
        ))}</ul>
      </EvidenceSection>

      <EvidenceSection title="More context" meta={`${Math.max(0, cautionCount)} cautions`} open={Boolean(openSections.context)} onToggle={() => toggle("context")}>
        <div className="context-grid">
          <Signal label="Weekly squeeze" value={timeframeSqueeze(result, "weekly")} />
          <Signal label="Next earnings" value={nextEarningsLabel(result)} tone={result.daysUntilNextEarnings !== undefined && result.daysUntilNextEarnings < 30 ? "warn" : "neutral"} />
          <Signal label="ATR (14)" value={formatNumber(result.indicators.atr14, { maximumFractionDigits: 2 })} />
          <Signal label="Today volume" value={shareVolumeLabel(result.currentVolume)} />
          <Signal label="Momentum" value={momentumLabel(result)} />
          <Signal label="Daily dots" value={dailySqueezeDotLabel(result)} />
        </div>
        {result.institutionalEdgeFactors?.length ? <div className="edge-list"><strong>Institutional Edge · context only</strong>{result.institutionalEdgeFactors.map((factor) => <span key={factor.name}>{factor.name}<b className={statusClass(factor.status)}>{displayStatus(factor.status)}</b></span>)}</div> : null}
        {result.alertMessage ? <p className="section-note">{result.alertMessage}</p> : null}
      </EvidenceSection>

      <div className="method-note"><SlidersHorizontal size={14} /><p><strong>Grade and mark are separate.</strong> Schwab options positioning confirms only when call activity is backed by comparable prior-session open-interest growth. Ambiguous activity, unsigned gamma, bounded max pain, and unavailable dark-pool data stay neutral.</p></div>
    </aside>
  );
}

function EvidenceSection({ title, meta, open, onToggle, children }: { title: string; meta: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className={`evidence-section${open ? " open" : ""}`}><button onClick={onToggle} aria-expanded={open}><span>{title}<small>{meta}</small></span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>{open ? <div className="evidence-content">{children}</div> : null}</section>;
}

function FactorRow({ result, factor }: { result: ScanResult; factor: ScanResult["institutionalFactors"][number] }) {
  const max = maxFactorContribution(result.institutionalFactors);
  const percent = Math.max(0, Math.min(100, (factor.contribution / max) * 100));
  return <div className="factor-row"><span>{factor.name}</span><div title={factor.detail}><i className={statusClass(factor.status)} style={{ width: `${percent}%` }} /></div><strong>{formatNumber(factor.contribution, { maximumFractionDigits: 1 })}</strong></div>;
}

function Signal({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "warn" | "risk" | "good" }) {
  return <div className="signal"><span>{label}</span><strong className={`signal-${tone}`}>{value}</strong></div>;
}

function SqueezeDotStrip({ count, max = 6 }: { count: number | null; max?: number }) {
  if (count === null) return <span className="dot-empty">—</span>;
  const filled = Math.max(0, Math.min(max, count));
  return <span className="dot-strip" role="img" aria-label={`${count} active squeeze dots`}>{Array.from({ length: max }).map((_, index) => <i key={index} className={`sq-dot${index < filled ? " on" : ""}`} />)}<small>{count}</small></span>;
}

function BrokerBadge({ brokerStatus, settings, onConnect }: { brokerStatus: BrokerStatus | null; settings: Settings | null; onConnect: () => void }) {
  const needsLogin = brokerStatus?.needsLogin && settings?.hasBrokerCredentials;
  return <button className={`broker-badge${brokerStatus?.ok ? " connected" : ""}`} onClick={needsLogin ? onConnect : undefined} disabled={!needsLogin}><span />{brokerStatus?.ok ? "Connected" : needsLogin ? "Connect Schwab" : "Setup needed"}</button>;
}

function DemoFundamentalsBadge({ sources }: { sources?: FundamentalFieldSources }) {
  const demoFields = Object.entries(sources ?? {}).filter(([, source]) => source === "demo").map(([field]) => field);
  return demoFields.length ? <span className="demo-badge" title={`Mock data used for: ${demoFields.join(", ")}`}>Mock data</span> : null;
}

function ResultSkeleton() {
  return <>{Array.from({ length: 8 }).map((_, index) => <div className="candidate-row skeleton-row" key={index} aria-hidden="true"><span className="skeleton-bar" /><span className="skeleton-bar" /><span className="skeleton-bar" /><span className="skeleton-bar" /></div>)}</>;
}

function EmptyState({ view, runScan }: { view: ViewMode; runScan: () => void }) {
  return <section className="empty-state"><WalletCards size={26} /><h2>{view === "watchlist" ? "Your watchlist is empty" : "No scan results yet"}</h2><p>{view === "watchlist" ? "Save a setup from the scanner to keep it here." : "Run a scan to rank current compression setups."}</p>{view === "scanner" ? <button className="scan-button" onClick={runScan}><Play size={16} />Run Scan</button> : null}</section>;
}

function sortResultsByGrade<T extends CandidateSummary>(results: T[]): T[] {
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

function mergeScanMetadata(current: ScanMetadata, data: Partial<ScanMetadata>): ScanMetadata {
  return {
    scanStatus: data.scanStatus ?? current.scanStatus,
    lastScanStartedAt: data.lastScanStartedAt ?? current.lastScanStartedAt,
    lastScanFinishedAt: data.lastScanFinishedAt ?? current.lastScanFinishedAt,
    lastScanFailedAt: data.lastScanFailedAt ?? current.lastScanFailedAt,
    lastScanMode: data.lastScanMode ?? current.lastScanMode,
    lastScanWarnings: data.lastScanWarnings ?? current.lastScanWarnings,
    scanDiagnostics: data.scanDiagnostics ?? current.scanDiagnostics,
    nextRefreshAt: data.nextRefreshAt ?? current.nextRefreshAt,
    isRefreshing: data.isRefreshing ?? current.isRefreshing
  };
}

function scanStatusLabel(status: string, loading: boolean): string {
  if (loading || status === "running") return "Scan refreshing";
  if (status === "complete") return "Scan complete";
  if (status === "failed") return "Scan failed";
  return "Cached results";
}

function lastUpdatedLabel(value: string | undefined, loading: boolean): string {
  if (loading) return "Refreshing in background";
  if (!value) return "Cached results";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Cached results";
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : value;
}

function priceAsOfLabel(value: string | undefined): string {
  if (!value) return "Scan price";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `Live price · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Scan price";
}

function lastCompletedBarLabel(candles: ScanResult["candles"], dataAsOf: string): string {
  const value = normalizeChartCandles(candles, new Date(dataAsOf)).at(-1)?.date;
  if (!value) return "unavailable";
  const date = new Date(value + (value.length === 10 ? "T12:00:00" : ""));
  return Number.isFinite(date.getTime()) ? `through ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : value;
}

function dailySqueezeDotCount(result: CandidateSummary): number | null {
  return typeof result.dailySqueezeDotCount === "number" ? result.dailySqueezeDotCount : null;
}

function dailySqueezeDotLabel(result: ScanResult): string {
  const dots = dailySqueezeDotCount(result);
  return dots === null ? "Run scan" : `${dots} active`;
}

function setupScoreValue(result: CandidateSummary): number {
  return typeof result.setupScore === "number" ? result.setupScore : 0;
}

function setupScoreLabel(result: CandidateSummary): string {
  return typeof result.setupScore === "number" ? `${formatNumber(result.setupScore, { maximumFractionDigits: 0 })}/100` : "Run scan";
}

function tradeMark(result: CandidateSummary): "Take" | "Avoid" {
  return result.tradeMark ?? "Avoid";
}

function tradeMarkReasons(result: ScanResult): string[] {
  const reasons = result.tradeMarkReasons ?? [];
  return reasons.length ? reasons : tradeMark(result) === "Take" ? ["Setup is technically valid and no avoid overlay is active."] : ["One or more trade overlays recommends avoiding this setup."];
}

function timeframeLabel(value: string | undefined): string {
  if (!value) return "Unavailable";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function timeframeSqueeze(result: ScanResult, timeframe: string): string {
  const status = result.squeezeStatusByTimeframe.find((item) => item.timeframe === timeframe);
  return status ? `${status.squeezeState} · ${timeframeLabel(status.bias)}` : "Unavailable";
}

function nextEarningsLabel(result: ScanResult): string {
  if (result.assetType === "etf") return "N/A · ETF";
  if (!result.nextEarningsDate) return "Unavailable";
  return result.nextEarningsDate + (typeof result.daysUntilNextEarnings === "number" ? ` · ${result.daysUntilNextEarnings}d` : "");
}

function momentumLabel(result: ScanResult): string {
  const color = result.indicators.momentumColor;
  return formatNumber(result.indicators.momentum, { maximumFractionDigits: 2 }) + (color ? ` · ${timeframeLabel(color)}` : "");
}

function shareVolumeLabel(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value >= 1_000_000) return `${formatNumber(value / 1_000_000, { maximumFractionDigits: 1 })}M`;
  if (value >= 1_000) return `${formatNumber(value / 1_000, { maximumFractionDigits: 0 })}K`;
  return formatNumber(value, { maximumFractionDigits: 0 });
}

function displayStatus(status: LayerStatus | undefined): "Bullish" | "Neutral" | "Avoid" {
  return status === "Bullish" || status === "Neutral" ? status : "Avoid";
}

function statusClass(status: LayerStatus | undefined): string {
  return displayStatus(status) === "Bullish" ? "status-bullish" : displayStatus(status) === "Neutral" ? "status-neutral" : "status-avoid";
}

function signalTone(value: string | undefined): "neutral" | "warn" | "risk" | "good" {
  if (!value || value === "neutral" || value === "no_data") return "neutral";
  if (["bullish", "supportive", "squeeze_prone", "accumulation", "tailwind", "confirmed_build", "confirming"].includes(value)) return "good";
  if (["bearish", "hostile", "distribution", "pin_risk", "contradicting"].includes(value)) return "risk";
  return "warn";
}

function positioningScoreLabel(result: ScanResult): string {
  if (["no_chain", "provider_error", "invalid_input"].includes(result.optionsPositioningAvailability ?? "")) return "No score";
  return typeof result.optionsPositioningScore === "number" ? `${formatNumber(result.optionsPositioningScore, { maximumFractionDigits: 0 })}/100` : "No score";
}

function positioningAvailabilityLabel(result: ScanResult): string {
  if (result.optionsPositioningAvailability === "awaiting_oi_comparison") return "Partial · OI history pending";
  if (result.optionsPositioningAvailability === "no_chain") return "No eligible chain";
  if (result.optionsPositioningAvailability === "provider_error") return "Provider error";
  if (result.optionsPositioningAvailability === "invalid_input") return "Invalid input";
  if (result.optionsPositioningAvailability === "available") {
    return result.optionsPositioningStatus === "confirmed" ? "Confirmed" : "Calculated";
  }
  if (typeof result.optionsPositioningScore === "number" && result.openInterestChangeSignal === "no_data") {
    return "Partial · OI history pending";
  }
  return typeof result.optionsPositioningScore === "number" ? "Calculated" : "Not populated";
}

function signalLabel(value: string | undefined): string {
  if (!value) return "Unavailable";
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function positioningSignalLabel(
  kind: "flow" | "gamma" | "darkPool" | "openInterest" | "ivRank" | "maxPain",
  value: string | undefined,
  availability: ScanResult["optionsPositioningAvailability"]
): string {
  if (["no_chain", "provider_error", "invalid_input"].includes(availability ?? "")) {
    if (kind === "darkPool") return "Unsupported by Schwab";
    if (kind === "ivRank") return "History unavailable";
    return "Unavailable";
  }
  if (kind === "gamma" && value === "neutral") return "Calculated · Direction unknown";
  if (kind === "maxPain" && value === "neutral") return "Calculated · Informational";
  if (kind === "darkPool" && value === "no_data") return "Unsupported by Schwab";
  if (kind === "ivRank" && value === "no_data") return "History unavailable";
  if (kind === "openInterest" && value === "no_data") return "Prior session needed";
  return signalLabel(value);
}

function layerLabel(layer: string): string {
  if (layer === "Institutional Context") return "Liquidity & eligibility";
  return layer === "Compression Quality" ? "Daily Squeeze Dots" : layer;
}

function layerDetail(result: ScanResult, layer: { layer: string; detail: string; status: string }): string {
  if (layer.layer !== "Compression Quality") return layer.detail;
  const dots = dailySqueezeDotCount(result);
  if (dots === null) return "Run scan for dot count.";
  if (dots < 2) return `At least 2 active Daily squeeze dots are required; current count is ${dots}.`;
  if (dots < 5) return `Daily squeeze is developing with ${dots} active dots.`;
  return `Daily chart has ${dots} consecutive active squeeze dots.`;
}

function maxFactorContribution(factors: ScanResult["institutionalFactors"]): number {
  return Math.max(1, ...factors.map((factor) => Math.max(0, factor.contribution)));
}

function money(value: number): string {
  const hasFraction = Math.abs(value - Math.trunc(value)) > 0.000001;
  return "$" + formatNumber(value, { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: hasFraction ? 2 : 0 });
}

function moneyOrUnavailable(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? money(value) : "Unavailable";
}

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6, ...options });
}

function dateOrUnavailable(value: string | undefined): string {
  if (!value) return "Unavailable";
  const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePrefix) return datePrefix;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
