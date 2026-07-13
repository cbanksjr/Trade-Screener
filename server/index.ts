import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import cors from "cors";
import compression from "compression";
import express from "express";
import cron from "node-cron";
import { isMarketRefreshWindow, MARKET_REFRESH_CRON, MARKET_TIME_ZONE } from "../shared/refreshSchedule";
import { config } from "./config";
import { addToWatchlist, readCachedScanResponse, readCandidateListResponse, readDisplayResult, readScanStatusResponse, readWatchlist, recordUniverseWarning, removeFromWatchlist, runScan, readSettings, shouldAutoRefresh, startScanRefresh, writeSettings, SettingsValidationError } from "./scanner";
import { initDb } from "./sqlite";
import { fetchFundamentalAnalysis, getSchwabLoginUrl, getSchwabStatus, handleSchwabCallback, hasSchwabCredentials } from "./schwab";
import { hasCachedDefaultUniverse, isLastDayOfMonth, refreshDefaultUniverse } from "./universe";

await initDb();
await refreshUniverseIfNeeded();

const app = express();
// Render (and similar hosts) terminate TLS one proxy hop in front of the app;
// without this, req.ip is the proxy's address and the scan rate limit lumps
// every client together.
app.set("trust proxy", 1);
app.use(cors({ origin: config.clientOrigin }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(optionalBasicAuth);

const scanRateLimit = createRateLimit({ maxRequests: 6, windowMs: 5 * 60 * 1000 });

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
    const response = await readCandidateListResponse();
    if (await shouldAutoRefresh()) void startScanRefresh();
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/results/:symbol", async (req, res, next) => {
  try {
    const result = await readDisplayResult(String(req.params.symbol ?? ""));
    if (!result) return res.status(404).json({ error: "Candidate not found." });
    res.json(result);
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
    await handleSchwabCallback(String(req.query.code ?? ""), String(req.query.state ?? ""));
    redirectToClient(res, "connected");
  } catch (error) {
    redirectToClient(res, "error", error instanceof Error ? error.message : "Schwab connection failed.");
  }
});

app.post("/api/scan", async (req, res, next) => {
  try {
    if (!scanRateLimit(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many scan requests. Wait a few minutes before starting another scan." });
      return;
    }
    await runScan();
    res.json(await readCandidateListResponse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scan/status", async (_req, res, next) => {
  try {
    res.json(await readScanStatusResponse());
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

app.post("/api/watchlist", async (req, res, next) => {
  try {
    const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "Symbol is required." });
      return;
    }
    await addToWatchlist(symbol);
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
  const status = error instanceof SettingsValidationError ? 400 : 500;
  res.status(status).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
});

function createRateLimit(input: { maxRequests: number; windowMs: number }) {
  const requestsByKey = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (requestsByKey.get(key) ?? []).filter((timestamp) => now - timestamp < input.windowMs);
    if (recent.length >= input.maxRequests) {
      requestsByKey.set(key, recent);
      return false;
    }
    requestsByKey.set(key, [...recent, now]);
    return true;
  };
}

function optionalBasicAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.appBasicAuthUsername || !config.appBasicAuthPassword) {
    next();
    return;
  }
  if (req.path === "/api/health" || req.path === "/api/schwab/callback") {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const [scheme, credentials] = header.split(" ");
  const decoded = scheme === "Basic" && credentials ? Buffer.from(credentials, "base64").toString("utf8") : "";
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";
  if (username === config.appBasicAuthUsername && password === config.appBasicAuthPassword) {
    next();
    return;
  }
  res.setHeader("WWW-Authenticate", "Basic realm=\"Trade Screener\"");
  res.status(401).send("Authentication required.");
}

async function refreshUniverseIfNeeded() {
  if (await hasCachedDefaultUniverse()) return;
  void refreshDefaultUniverse().catch((error) => {
    const message = "Default universe startup refresh failed: " + (error instanceof Error ? error.message : String(error));
    console.warn(message);
    void recordUniverseWarning(message);
  });
}

cron.schedule(MARKET_REFRESH_CRON, () => {
  if (!isMarketRefreshWindow()) return;
  void shouldAutoRefresh()
    .then((due) => due ? startScanRefresh() : undefined)
    .catch((error) => console.warn("Scheduled scan refresh failed:", error));
}, { timezone: MARKET_TIME_ZONE });

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
