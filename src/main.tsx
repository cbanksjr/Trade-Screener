import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, BarChart3, CheckCircle2, Play, Settings as SettingsIcon, XCircle } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BrokerStatus, ScanResponse, ScanResult, Settings } from "../shared/types";
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
  }
};

function App() {
  const [results, setResults] = React.useState<ScanResult[]>([]);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [selected, setSelected] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [mode, setMode] = React.useState<string>("demo");
  const [message, setMessage] = React.useState("");
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [brokerStatus, setBrokerStatus] = React.useState<BrokerStatus | null>(null);
  const [scanStatus, setScanStatus] = React.useState<string>("idle");
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<string>("");
  const [nextRefreshAt, setNextRefreshAt] = React.useState<string>("");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const schwabResult = params.get("schwab");
    const schwabMessage = params.get("message");

    if (schwabResult === "connected") setMessage("Schwab connected. You can run a live scan now.");
    if (schwabResult === "error") setMessage(schwabMessage ? "Schwab connection failed: " + schwabMessage : "Schwab connection failed.");
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
    setResults(data.results ?? []);
    if (data.settings) setSettings(data.settings);
    setSelected((current) => current && data.results?.some((item) => item.symbol === current) ? current : data.results?.[0]?.symbol ?? "");
    setMode(data.mode ?? "demo");
    setWarnings(data.warnings ?? []);
    setScanStatus(data.scanStatus ?? "idle");
    setLastRefreshedAt(data.lastScanFinishedAt ?? "");
    setNextRefreshAt(data.nextRefreshAt ?? "");
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

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Options Swing Screener</h1>
          <p>Automatic S&amp;P 500 + Nasdaq 100 screening for long and short squeeze-style setups.</p>
        </div>
        <button className="primary" onClick={runScan} disabled={loading}>
          <Play size={18} />
          {loading ? "Scanning..." : "Run Scan"}
        </button>
      </header>

      <section className="status-strip">
        <Stat icon={<Activity />} label="Scan" value={loading || scanStatus === "running" ? "REFRESHING" : scanStatus.toUpperCase()} />
        <Stat icon={<BarChart3 />} label="Symbols" value={String(results.length)} />
        <Stat icon={<CheckCircle2 />} label="Passing Universe" value={String(results.filter((item) => item.passesUniverse).length)} />
        <Stat icon={<SettingsIcon />} label="Schwab" value={brokerStatus?.ok ? "Connected" : settings?.hasBrokerCredentials ? "Connect" : "Setup Needed"} />
      </section>

      {message && <div className="notice">{message}</div>}
      {(lastRefreshedAt || nextRefreshAt || loading) && <div className="notice">{loading ? "Refreshing in background... " : ""}{lastRefreshedAt ? "Last refreshed " + new Date(lastRefreshedAt).toLocaleTimeString() : "No completed scan yet"}{nextRefreshAt ? " · Next refresh " + new Date(nextRefreshAt).toLocaleTimeString() : ""}</div>}
      {warnings.length > 0 && (
        <section className="warning-strip">
          {warnings.slice(0, 4).map((warning) => <span key={warning}>{warning}</span>)}
          {warnings.length > 4 && <span>{warnings.length - 4} more warning(s)</span>}
        </section>
      )}

      <section className="layout">
        <div className="panel list-panel">
          <div className="panel-head">
            <h2>Dashboard</h2>
            <span>{new Date().toLocaleDateString()}</span>
          </div>
          <div className="table">
            {results.map((result) => (
              <button className={"row " + (result.symbol === active?.symbol ? "active" : "")} key={result.symbol} onClick={() => setSelected(result.symbol)}>
                <span className={"grade grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
                <span>
                  <strong>{result.symbol}</strong>
                  <small>{result.setupDirection.toUpperCase()} · ${result.price.toFixed(2)} · {Math.round((result.score / result.maxScore) * 100)}% · {result.dataSource}</small>
                </span>
                <span className={result.passesUniverse ? "pass" : "fail"}>{result.passesUniverse ? "Qualified" : "Filtered"}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="detail">
          {active ? <TickerDetail result={active} /> : <EmptyState runScan={runScan} />}
        </div>

        <SettingsPanel settings={settings} brokerStatus={brokerStatus} />
      </section>
    </main>
  );
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

function TickerDetail({ result }: { result: ScanResult }) {
  return (
    <>
      <section className="panel hero-panel">
        <div>
          <span className={"grade large grade-" + result.grade.replace("+", "plus")}>{result.grade}</span>
          <h2>{result.symbol}</h2>
          <p>{result.setupDirection.toUpperCase()} · ${result.price.toFixed(2)} · Score {result.score}/{result.maxScore}</p>
        </div>
        <div className="indicator-grid">
          <Metric label="Daily Sqz" value={result.indicators.squeezeState} />
          <Metric label="Weekly Sqz" value={result.weeklyIndicators?.squeezeState ?? "unavailable"} />
          <Metric label="Momentum" value={result.indicators.momentum.toFixed(2)} />
          <Metric label="21 EMA" value={result.indicators.ema21.toFixed(2)} />
          <Metric label="50 EMA" value={result.indicators.ema50.toFixed(2)} />
          <Metric label="ATR" value={result.indicators.atr14.toFixed(2)} />
          <Metric label="Dollar Vol" value={money(result.avgDollarVolume20d)} />
          <Metric label="Direction" value={result.setupDirection.toUpperCase()} />
          <Metric label="1h" value={timeframeLabel(result.lowerTimeframes?.oneHour?.bias)} />
          <Metric label="4h" value={timeframeLabel(result.lowerTimeframes?.fourHour?.bias)} />
          <Metric label="Source" value={result.dataSource} />
        </div>
      </section>

      {result.warnings.length > 0 && (
        <section className="panel inline-warnings">
          {result.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </section>
      )}

      <section className="panel chart-panel">
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={result.candles}>
            <XAxis dataKey="date" hide />
            <YAxis domain={["dataMin - 5", "dataMax + 5"]} width={64} />
            <Tooltip />
            <Area type="monotone" dataKey="close" stroke="#1d7a8c" fill="#d5eef2" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Checklist</h2>
          <span>Transparent scoring</span>
        </div>
        <div className="rules">
          {result.rules.map((rule) => (
            <div className="rule" key={rule.id}>
              {rule.passed ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}
              <span>
                <strong>{rule.label}</strong>
                <small>{rule.detail}</small>
              </span>
              <b>{rule.points}/{rule.maxPoints}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{result.setupDirection === "long" ? "Liquid Calls" : "Liquid Puts"}</h2>
          <span>30-180 DTE target</span>
        </div>
        <div className="contracts">
          {result.suggestedOptions.map((contract) => (
            <div className="contract" key={contract.symbol}>
              <strong>{contract.strike}{contract.optionType === "call" ? "C" : "P"} · {contract.expirationDate}</strong>
              <span>Bid/Ask ${contract.bid.toFixed(2)} / ${contract.ask.toFixed(2)}</span>
              <span>OI {contract.openInterest} · Vol {contract.volume} · Spread {contract.spreadPct.toFixed(1)}%</span>
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

function SettingsPanel({ settings, brokerStatus }: {
  settings: Settings | null;
  brokerStatus: BrokerStatus | null;
}) {
  async function connectSchwab() {
    const response = await api.connectSchwab();
    window.location.href = response.loginUrl;
  }

  return (
    <aside className="panel settings">
      <div className="panel-head">
        <h2>Settings</h2>
        <SettingsIcon size={18} />
      </div>
      <div className="settings-note mode-note">
        Automatic universe: {settings?.defaultUniverseName ?? "S&P 500 + Nasdaq 100"} ({settings?.defaultUniverseCount ?? 0} symbols)
        {settings?.defaultUniverseLastCheckedAt ? " · refreshed " + new Date(settings.defaultUniverseLastCheckedAt).toLocaleDateString() : ""}
      </div>
      <div className="settings-note">
        The screener automatically checks the default universe and applies the live Schwab checklist. There is no user-managed universe in this version.
      </div>
      <div className={"api-status " + (brokerStatus?.ok ? "connected" : "")}>
        <strong>Schwab API</strong>
        <span>{brokerStatus?.message ?? "Checking connection..."}</span>
        <small>{settings?.brokerBaseUrl}</small>
        <small>Callback: {settings?.brokerCallbackUrl}</small>
        {brokerStatus?.needsLogin && settings?.hasBrokerCredentials && <button onClick={connectSchwab}>Connect Schwab</button>}
      </div>
    </aside>
  );
}

function timeframeLabel(value: string | undefined): string {
  if (!value) return "Unavailable";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function money(value: number): string {
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
