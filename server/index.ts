import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { readCachedScanResponse, readWatchlist, recordUniverseWarning, removeFromWatchlist, runScan, readSettings, shouldAutoRefresh, startScanRefresh, writeSettings } from "./scanner";
import { initDb } from "./sqlite";
import { fetchFundamentalAnalysis, getSchwabLoginUrl, getSchwabStatus, handleSchwabCallback, hasSchwabCredentials } from "./schwab";
import { hasCachedDefaultUniverse, isLastDayOfMonth, refreshDefaultUniverse } from "./universe";

await initDb();
await refreshUniverseIfNeeded();

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    res.json(await readSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    res.json(await writeSettings(req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/results", async (_req, res, next) => {
  try {
    const response = await readCachedScanResponse();
    if (await shouldAutoRefresh()) void startScanRefresh();
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/schwab/status", async (_req, res, next) => {
  try {
    const status = await getSchwabStatus();
    res.json(status.needsLogin && hasSchwabCredentials() ? { ...status, loginUrl: getSchwabLoginUrl() } : status);
  } catch (error) {
    next(error);
  }
});

app.get("/api/schwab/login", (_req, res, next) => {
  try {
    res.json({ loginUrl: getSchwabLoginUrl() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/schwab/callback", async (req, res) => {
  const schwabError = typeof req.query.error === "string" ? req.query.error : "";
  if (schwabError) {
    redirectToClient(res, "error", schwabError);
    return;
  }

  try {
    await handleSchwabCallback(String(req.query.code ?? ""));
    redirectToClient(res, "connected");
  } catch (error) {
    redirectToClient(res, "error", error instanceof Error ? error.message : "Schwab connection failed.");
  }
});

app.post("/api/scan", async (_req, res, next) => {
  try {
    res.json(await runScan());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scan/status", async (_req, res, next) => {
  try {
    res.json(await readCachedScanResponse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/watchlist", async (_req, res, next) => {
  try {
    res.json(await readWatchlist());
  } catch (error) {
    next(error);
  }
});

app.delete("/api/watchlist/:symbol", async (req, res, next) => {
  try {
    await removeFromWatchlist(String(req.params.symbol ?? "").trim().toUpperCase());
    res.json(await readWatchlist());
  } catch (error) {
    next(error);
  }
});

app.get("/api/fundamentals/:symbol", async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
    const scanResult = (await readCachedScanResponse()).results.find((result) => result.symbol === symbol);
    res.json(await fetchFundamentalAnalysis(symbol, scanResult));
  } catch (error) {
    next(error);
  }
});

function redirectToClient(res: express.Response, schwab: "connected" | "error", message?: string) {
  const url = new URL(config.clientOrigin);
  url.searchParams.set("schwab", schwab);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  res.redirect(url.toString());
}

if (config.isProduction) {
  const distPath = resolve("dist");
  app.use(express.static(distPath));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(resolve(distPath, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
});

async function refreshUniverseIfNeeded() {
  if (await hasCachedDefaultUniverse()) return;
  void refreshDefaultUniverse().catch((error) => {
    const message = "Default universe startup refresh failed: " + (error instanceof Error ? error.message : String(error));
    console.warn(message);
    void recordUniverseWarning(message);
  });
}

cron.schedule("35 8 * * 1-5", () => {
  void startScanRefresh();
}, { timezone: "America/Chicago" });

cron.schedule("10 18 28-31 * *", () => {
  if (!isLastDayOfMonth()) return;
  void refreshDefaultUniverse().catch((error) => {
    const message = "Default universe refresh failed: " + (error instanceof Error ? error.message : String(error));
    console.warn(message);
    void recordUniverseWarning(message);
  });
}, { timezone: "America/Chicago" });

const server = config.httpsEnabled
  ? https.createServer(loadHttpsCredentials(), app)
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const protocol = config.httpsEnabled ? "https" : "http";
  console.log(`Options swing screener API running at ${protocol}://${config.host}:${config.port}`);
});

function loadHttpsCredentials() {
  ensureLocalCertificate();
  return {
    key: readFileSync(config.httpsKeyPath),
    cert: readFileSync(config.httpsCertPath)
  };
}

function ensureLocalCertificate() {
  if (existsSync(config.httpsKeyPath) && existsSync(config.httpsCertPath)) return;
  mkdirSync(dirname(config.httpsKeyPath), { recursive: true });
  mkdirSync(dirname(config.httpsCertPath), { recursive: true });
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "365",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout",
    config.httpsKeyPath,
    "-out",
    config.httpsCertPath
  ], { stdio: "ignore" });
}
