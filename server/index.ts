import cors from "cors";
import express from "express";
import cron from "node-cron";
import { config } from "./config";
import { importFundamentalsCsv } from "./csv";
import { runScan, readSettings, writeSettings } from "./scanner";
import { getCachedResults, initDb } from "./sqlite";
import { getTradierStatus } from "./tradier";

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

app.get("/api/tradier/status", async (_req, res, next) => {
  try {
    res.json(await getTradierStatus());
  } catch (error) {
    next(error);
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

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
});

cron.schedule("35 8 * * 1-5", () => {
  void runScan();
}, { timezone: "America/Chicago" });

app.listen(config.port, "127.0.0.1", () => {
  console.log(`Options swing screener API running at http://127.0.0.1:${config.port}`);
});
