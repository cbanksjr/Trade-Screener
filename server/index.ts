import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import https from "node:https";
import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { runScan, readSettings, writeSettings } from "./scanner";
import { getCachedResults, initDb } from "./sqlite";
import { getSchwabLoginUrl, getSchwabStatus, handleSchwabCallback, hasSchwabCredentials } from "./schwab";
import { hasCachedDefaultUniverse, isLastDayOfMonth, refreshDefaultUniverse } from "./universe";

initDb();
refreshUniverseIfNeeded();

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/settings", (_req, res) => {
  res.json(readSettings());
});

app.put("/api/settings", (req, res) => {
  res.json(writeSettings(req.body));
});

app.get("/api/results", (_req, res) => {
  res.json({ results: getCachedResults(), settings: readSettings(), warnings: [] });
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

function redirectToClient(res: express.Response, schwab: "connected" | "error", message?: string) {
  const url = new URL(config.clientOrigin);
  url.searchParams.set("schwab", schwab);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  res.redirect(url.toString());
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
});

function refreshUniverseIfNeeded() {
  if (hasCachedDefaultUniverse()) return;
  void refreshDefaultUniverse().catch((error) => {
    console.warn("Default universe startup refresh failed:", error instanceof Error ? error.message : error);
  });
}

cron.schedule("35 8 * * 1-5", () => {
  void runScan();
}, { timezone: "America/Chicago" });

cron.schedule("10 18 28-31 * *", () => {
  if (!isLastDayOfMonth()) return;
  void refreshDefaultUniverse().catch((error) => {
    console.warn("Default universe refresh failed:", error instanceof Error ? error.message : error);
  });
}, { timezone: "America/Chicago" });

const server = config.httpsEnabled
  ? https.createServer(loadHttpsCredentials(), app)
  : http.createServer(app);

server.listen(config.port, "127.0.0.1", () => {
  const protocol = config.httpsEnabled ? "https" : "http";
  console.log(`Options swing screener API running at ${protocol}://127.0.0.1:${config.port}`);
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
