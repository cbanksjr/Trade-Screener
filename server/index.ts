import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { importFundamentalsCsv } from "./csv";
import { runScan, readSettings, writeSettings } from "./scanner";
import { getCachedResults, initDb } from "./sqlite";
import { getSchwabLoginUrl, getSchwabStatus, handleSchwabCallback, hasSchwabCredentials } from "./schwab";

initDb();

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

app.post("/api/fundamentals/import", (req, res, next) => {
  try {
    res.json(importFundamentalsCsv(String(req.body.csv ?? "")));
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

cron.schedule("35 8 * * 1-5", () => {
  void runScan();
}, { timezone: "America/Chicago" });

app.listen(config.port, "127.0.0.1", () => {
  console.log(`Options swing screener API running at http://127.0.0.1:${config.port}`);
});
