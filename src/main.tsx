import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, BarChart3, CheckCircle2, Play, Settings as SettingsIcon, Upload, XCircle } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ScanResponse, ScanResult, Settings, TradierStatus } from "../shared/types";
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
  async settings(input: Partial<Settings>): Promise<Settings> {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    return response.json();
  },
  async importFundamentals(csv: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const response = await fetch("/api/fundamentals/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv })
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "CSV import failed.");
    return response.json();
  },
  async tradierStatus(): Promise<TradierStatus> {
    const response = await fetch("/api/tradier/status");
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
  const [tradierStatus, setTradierStatus] = React.useState<TradierStatus | null>(null);

  React.useEffect(() => {
    api.results().then((data) => {
      setResults(data.results ?? []);
      if (data.settings) setSettings(data.settings);
      setSelected(data.results?.[0]?.symbol ?? "");
      setWarnings(data.warnings ?? []);
    });
    api.tradierStatus().then(setTradierStatus).catch(() => {
      setTradierStatus({
        configured: false,
        baseUrl: "",
        ok: false,
        checkedAt: new Date().toISOString(),
        message: "Unable to check Tradier status."
      });
    });
  }, []);

  const active = results.find((item) => item.symbol === selected) ?? results[0];

  async function runScan() {
    setLoading(true);
    setMessage("");
    try {
      const data = await api.scan();
      setResults(data.results);
      setSettings(data.settings);
      setSelected(data.results[0]?.symbol ?? "");
      setMode(data.mode);
      setWarnings(data.warnings);
      api.tradierStatus().then(setTradierStatus).catch(() => undefined);
      setMessage(`Scan complete: ${data.results.length} symbols scored.`);
    } finally {
      setLoading(false);
    }
  }

  async function saveSymbols(symbols: string) {
    const next = await api.settings({ symbols: symbols.split(/[,\s]+/).filter(Boolean) });
    setSettings(next);
    setMessage("Watchlist saved.");
  }

  async function setScanMode(scanMode: Settings["scanMode"]) {
    const next = await api.settings({ scanMode });
    setSettings(next);
    setMessage(scanMode === "universe" ? "Universe scan enabled." : "Watchlist scan enabled.");
  }

  async function importCsv(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setMessage("");
    setWarnings([]);
    try {
      const csv = await file.text();
      const response = await api.importFundamentals(csv);
      const next = await api.settings({ scanMode: "universe" });
      setSettings(next);
      if (response.imported === 0) {
        setResults([]);
        setMessage("No rows imported. Check that your CSV has symbol, beta, and market cap columns.");
        setWarnings(response.errors);
        return;
      }
      const scan = await api.scan();
      setResults(scan.results);
      setSettings(scan.settings);
      setSelected(scan.results[0]?.symbol ?? "");
      setMode(scan.mode);
      setWarnings([...response.errors, ...scan.warnings]);
      setMessage(scan.results.length
        ? `Imported ${response.imported} row(s), skipped ${response.skipped}, and found ${scan.results.length} matching setup(s).`
        : `Imported ${response.imported} row(s), skipped ${response.skipped}, and found no matching setups right now.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CSV import failed.");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Options Swing Screener</h1>
          <p>Squeeze Pro-style long setups graded with a transparent checklist.</p>
        </div>
        <button className="primary" onClick={runScan} disabled={loading}>
          <Play size={18} />
          {loading ? "Scanning..." : "Run Scan"}
        </button>
      </header>

      <section className="status-strip">
        <Stat icon={<Activity />} label="Mode" value={mode.toUpperCase()} />
        <Stat icon={<BarChart3 />} label="Symbols" value={String(results.length)} />
        <Stat icon={<CheckCircle2 />} label="Passing Universe" value={String(results.filter((item) => item.passesUniverse).length)} />
        <Stat icon={<SettingsIcon />} label="Tradier" value={tradierStatus?.ok ? "Connected" : settings?.hasTradierToken ? "Check Failed" : "Demo Fallback"} />
      </section>

      {message && <div className="notice">{message}</div>}
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
              <button className={`row ${result.symbol === active?.symbol ? "active" : ""}`} key={result.symbol} onClick={() => setSelected(result.symbol)}>
                <span className={`grade grade-${result.grade.replace("+", "plus")}`}>{result.grade}</span>
                <span>
                  <strong>{result.symbol}</strong>
                  <small>${result.price.toFixed(2)} · {Math.round((result.score / result.maxScore) * 100)}% · {result.dataSource}</small>
                </span>
                <span className={result.passesUniverse ? "pass" : "fail"}>{result.passesUniverse ? "Universe" : "Filtered"}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="detail">
          {active ? <TickerDetail result={active} /> : <EmptyState runScan={runScan} />}
        </div>

        <SettingsPanel settings={settings} tradierStatus={tradierStatus} setScanMode={setScanMode} saveSymbols={saveSymbols} importCsv={importCsv} />
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
          <span className={`grade large grade-${result.grade.replace("+", "plus")}`}>{result.grade}</span>
          <h2>{result.symbol}</h2>
          <p>${result.price.toFixed(2)} · Score {result.score}/{result.maxScore}</p>
        </div>
        <div className="indicator-grid">
          <Metric label="Squeeze" value={result.indicators.squeezeState} />
          <Metric label="Momentum" value={result.indicators.momentum.toFixed(2)} />
          <Metric label="21 EMA" value={result.indicators.ema21.toFixed(2)} />
          <Metric label="50 EMA" value={result.indicators.ema50.toFixed(2)} />
          <Metric label="ATR" value={result.indicators.atr14.toFixed(2)} />
          <Metric label="Dollar Vol" value={money(result.avgDollarVolume20d)} />
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
          <h2>Liquid Calls</h2>
          <span>30-180 DTE target</span>
        </div>
        <div className="contracts">
          {result.suggestedOptions.map((contract) => (
            <div className="contract" key={contract.symbol}>
              <strong>{contract.strike}C · {contract.expirationDate}</strong>
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

function SettingsPanel({ settings, tradierStatus, setScanMode, saveSymbols, importCsv }: {
  settings: Settings | null;
  tradierStatus: TradierStatus | null;
  setScanMode: (scanMode: Settings["scanMode"]) => void;
  saveSymbols: (symbols: string) => void;
  importCsv: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [symbols, setSymbols] = React.useState("");
  React.useEffect(() => {
    setSymbols(settings?.symbols.join(", ") ?? "");
  }, [settings]);

  return (
    <aside className="panel settings">
      <div className="panel-head">
        <h2>Settings</h2>
        <SettingsIcon size={18} />
      </div>
      <div className="segmented" aria-label="Scan mode">
        <button className={settings?.scanMode === "universe" ? "selected" : ""} onClick={() => setScanMode("universe")}>Universe</button>
        <button className={settings?.scanMode === "watchlist" ? "selected" : ""} onClick={() => setScanMode("watchlist")}>Watchlist</button>
      </div>
      <div className="settings-note mode-note">
        Universe rows imported: {settings?.importedUniverseCount ?? 0}
      </div>
      <label>
        Watchlist
        <textarea value={symbols} onChange={(event) => setSymbols(event.target.value)} />
      </label>
      <button onClick={() => saveSymbols(symbols)}>Save Watchlist</button>
      <label className="upload">
        <Upload size={18} />
        Import fundamentals CSV
        <input type="file" accept=".csv" onChange={importCsv} />
      </label>
      <div className="settings-note">
        CSV columns: symbol, beta, market_cap, avg_dollar_volume_20d.
      </div>
      <div className={`api-status ${tradierStatus?.ok ? "connected" : ""}`}>
        <strong>Tradier API</strong>
        <span>{tradierStatus?.message ?? "Checking connection..."}</span>
        <small>{settings?.tradierBaseUrl}</small>
      </div>
    </aside>
  );
}

function money(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
