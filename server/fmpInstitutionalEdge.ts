import type { AssetType, InstitutionalEdgeFactor, InstitutionalEdgeSummary, LayerStatus } from "../shared/types";
import { config } from "./config";
import { fetchWithRetry } from "./httpRetry";
import { getSetting, setSetting } from "./sqlite";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type EndpointId =
  | "financial-scores"
  | "grades-consensus"
  | "price-target-summary"
  | "insider-statistics"
  | "etf-info"
  | "etf-sector-weightings";

type EndpointAvailability = {
  available: boolean;
  updatedAt: string;
  reason?: string;
};

type EndpointCacheEntry = {
  updatedAt: string;
  data: unknown;
};

export type FmpInstitutionalEdgeCache = {
  availability: Partial<Record<EndpointId, EndpointAvailability>>;
  responses: Record<string, Partial<Record<EndpointId, EndpointCacheEntry>>>;
};

export type FmpInstitutionalEdgeResult = {
  edge: InstitutionalEdgeSummary;
  warnings: string[];
  usedLive: boolean;
};

const CACHE_KEY = "fmpInstitutionalEdgeCache";
const DEFAULT_EDGE: InstitutionalEdgeSummary = {
  status: "Neutral",
  score: 0,
  adjustment: 0,
  factors: [],
  warnings: []
};
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;

export async function createFmpInstitutionalEdgeScanProvider(): Promise<ReturnType<typeof createFmpInstitutionalEdgeProvider> | undefined> {
  if (!config.fmpInstitutionalEdgeEnabled || !config.fmpApiKey) return undefined;
  const cache = await getSetting<FmpInstitutionalEdgeCache>(CACHE_KEY, { availability: {}, responses: {} });
  const provider = createFmpInstitutionalEdgeProvider({
    apiKey: config.fmpApiKey,
    baseUrl: config.fmpBaseUrl,
    maxCalls: Math.max(0, config.fmpInstitutionalEdgeMaxCallsPerScan),
    starterSafeMode: config.fmpStarterSafeMode,
    probeTtlMs: Math.max(1, config.fmpInstitutionalEdgeProbeTtlHours) * 60 * 60 * 1000,
    cache
  });
  return {
    ...provider,
    async flush() {
      if (provider.isDirty()) await setSetting(CACHE_KEY, provider.cache());
    }
  };
}

export function createFmpInstitutionalEdgeProvider(input: {
  apiKey: string;
  baseUrl: string;
  maxCalls: number;
  starterSafeMode?: boolean;
  probeTtlMs?: number;
  cache?: FmpInstitutionalEdgeCache;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  let remainingCalls = input.maxCalls;
  let dirty = false;
  const cache: FmpInstitutionalEdgeCache = {
    availability: { ...(input.cache?.availability ?? {}) },
    responses: { ...(input.cache?.responses ?? {}) }
  };
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const starterSafeMode = input.starterSafeMode ?? true;
  const probeTtlMs = input.probeTtlMs ?? RESPONSE_TTL_MS;

  async function enrich(symbol: string, assetType: AssetType, price: number): Promise<FmpInstitutionalEdgeResult> {
    const upperSymbol = symbol.trim().toUpperCase();
    if (!upperSymbol || !input.apiKey) return { edge: DEFAULT_EDGE, warnings: [], usedLive: false };

    const warnings: string[] = [];
    let usedLive = false;
    const factors: InstitutionalEdgeFactor[] = [];

    if (assetType === "etf") {
      const [info, sectors] = await Promise.all([
        loadEndpoint(upperSymbol, "etf-info", { symbol: upperSymbol }),
        loadEndpoint(upperSymbol, "etf-sector-weightings", { symbol: upperSymbol })
      ]);
      usedLive = Boolean(info.usedLive || sectors.usedLive);
      warnings.push(...info.warnings, ...sectors.warnings);
      const etfQuality = normalizeEtfInfo(info.data);
      const etfSector = normalizeEtfSectorWeightings(sectors.data);
      if (etfQuality) factors.push(etfQuality);
      if (etfSector) factors.push(etfSector);
      return { edge: summarizeFactors(factors, warnings), warnings, usedLive };
    }

    const [financial, grades, targets, insider] = await Promise.all([
      loadEndpoint(upperSymbol, "financial-scores", { symbol: upperSymbol }),
      loadEndpoint(upperSymbol, "grades-consensus", { symbol: upperSymbol }),
      loadEndpoint(upperSymbol, "price-target-summary", { symbol: upperSymbol }),
      loadEndpoint(upperSymbol, "insider-statistics", { symbol: upperSymbol })
    ]);

    usedLive = [financial, grades, targets, insider].some((item) => item.usedLive);
    warnings.push(...financial.warnings, ...grades.warnings, ...targets.warnings, ...insider.warnings);
    const financialQuality = normalizeFinancialScores(financial.data);
    const analystConviction = normalizeAnalystConviction(grades.data, targets.data, price);
    const insiderSafety = normalizeInsiderStatistics(insider.data);
    if (financialQuality) factors.push(financialQuality);
    if (analystConviction) factors.push(analystConviction);
    if (insiderSafety) factors.push(insiderSafety);

    return { edge: summarizeFactors(factors, warnings), warnings, usedLive };
  }

  async function loadEndpoint(symbol: string, endpoint: EndpointId, params: Record<string, string>): Promise<{ data?: unknown; warnings: string[]; usedLive: boolean }> {
    const availability = cache.availability[endpoint];
    if (starterSafeMode && availability && isFresh(availability.updatedAt, probeTtlMs, now()) && !availability.available) {
      return { warnings: [`${endpoint} unavailable for current FMP plan; skipped.`], usedLive: false };
    }

    const cached = cache.responses[symbol]?.[endpoint];
    if (cached && isFresh(cached.updatedAt, responseTtl(), now())) return { data: cached.data, warnings: [], usedLive: false };
    if (remainingCalls <= 0) return { warnings: ["FMP Institutional Edge call budget exhausted."], usedLive: false };

    remainingCalls -= 1;
    const path = endpointPath(endpoint);
    const response = await fetchWithRetry(() => fetchImpl(fmpUrl(input.baseUrl, path, { ...params, apikey: input.apiKey })));
    const text = await response.text();
    if (isUnavailableStatus(response.status)) {
      markAvailability(endpoint, false, `FMP ${path} unavailable: ${response.status}`);
      return { warnings: [`FMP ${path} unavailable for current plan; skipped.`], usedLive: true };
    }
    if (response.status === 429) {
      markAvailability(endpoint, false, `FMP ${path} rate limited.`);
      return { warnings: [`FMP ${path} was rate limited; skipped.`], usedLive: true };
    }
    if (!response.ok) return { warnings: [`FMP ${path} request failed: ${response.status} ${response.statusText}`], usedLive: true };

    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      markAvailability(endpoint, false, `FMP ${path} returned malformed JSON.`);
      return { warnings: [`FMP ${path} returned malformed JSON; skipped.`], usedLive: true };
    }

    const warning = fmpPayloadWarning(data);
    if (warning && isPlanWarning(warning)) {
      markAvailability(endpoint, false, warning);
      return { warnings: [`FMP ${path} unavailable for current plan; skipped.`], usedLive: true };
    }
    if (warning) return { warnings: [`FMP ${path}: ${warning}`], usedLive: true };

    markAvailability(endpoint, true);
    cache.responses[symbol] = {
      ...(cache.responses[symbol] ?? {}),
      [endpoint]: { updatedAt: now().toISOString(), data }
    };
    dirty = true;
    return { data, warnings: [], usedLive: true };
  }

  function markAvailability(endpoint: EndpointId, available: boolean, reason?: string) {
    cache.availability[endpoint] = { available, reason, updatedAt: now().toISOString() };
    dirty = true;
  }

  return {
    enrich,
    cache: () => cache,
    remainingCalls: () => remainingCalls,
    isDirty: () => dirty,
    async flush() {
      // Overridden by createFmpInstitutionalEdgeScanProvider where persistent settings are available.
    }
  };
}

export function normalizeFinancialScores(payload: unknown): InstitutionalEdgeFactor | undefined {
  const item = firstObject(payload);
  if (!item) return undefined;
  const piotroski = numberValue(item.piotroskiScore, item.piotroski_score, item.PiotroskiScore);
  const altman = numberValue(item.altmanZScore, item.altmanZscore, item.AltmanZScore);
  if (piotroski === undefined && altman === undefined) return undefined;
  const bullish = (piotroski !== undefined && piotroski >= 6) || (altman !== undefined && altman > 3);
  const bearish = (piotroski !== undefined && piotroski <= 3) || (altman !== undefined && altman < 1.8);
  const status: LayerStatus = bearish && !bullish ? "Bearish" : bullish ? "Bullish" : "Neutral";
  return edgeFactor("Financial Quality", status, `Piotroski ${formatValue(piotroski)}, Altman Z ${formatValue(altman)}.`);
}

export function normalizeAnalystConviction(gradesPayload: unknown, targetPayload: unknown, price: number): InstitutionalEdgeFactor | undefined {
  const grades = normalizeGradesConsensus(gradesPayload);
  const target = normalizePriceTarget(targetPayload, price);
  if (!grades && !target) return undefined;
  const status: LayerStatus = grades?.status === "Bearish" || target?.status === "Bearish"
    ? "Bearish"
    : grades?.status === "Bullish" && target?.status === "Bullish"
      ? "Bullish"
      : "Neutral";
  const detail = [grades?.detail, target?.detail].filter(Boolean).join(" ");
  return edgeFactor("Analyst Conviction", status, detail || "Analyst data was mixed.");
}

export function normalizeInsiderStatistics(payload: unknown): InstitutionalEdgeFactor | undefined {
  const item = firstObject(payload);
  if (!item) return undefined;
  const purchases = numberValue(item.totalPurchases, item.purchases, item.buyTransactions, item.acquiredTransactions);
  const sales = numberValue(item.totalSales, item.sales, item.sellTransactions, item.disposedTransactions);
  if (purchases === undefined && sales === undefined) return undefined;
  const buyCount = purchases ?? 0;
  const sellCount = sales ?? 0;
  const status: LayerStatus = sellCount > 0 && sellCount >= buyCount * 2 ? "Bearish" : buyCount > sellCount ? "Bullish" : "Neutral";
  return edgeFactor("Insider Safety", status, `Insider purchases ${formatValue(purchases)}, sales ${formatValue(sales)}.`);
}

export function normalizeEtfInfo(payload: unknown): InstitutionalEdgeFactor | undefined {
  const item = firstObject(payload);
  if (!item) return undefined;
  const aum = numberValue(item.assetsUnderManagement, item.aum, item.netAssets);
  const expenseRatio = normalizeExpenseRatio(numberValue(item.expenseRatio, item.expense_ratio));
  if (aum === undefined && expenseRatio === undefined) return undefined;
  const bullish = (aum === undefined || aum >= 1_000_000_000) && (expenseRatio === undefined || expenseRatio <= 0.01);
  const bearish = (aum !== undefined && aum < 500_000_000) || (expenseRatio !== undefined && expenseRatio > 0.01);
  return edgeFactor("ETF Quality", bearish ? "Bearish" : bullish ? "Bullish" : "Neutral", `AUM ${formatMoney(aum)}, expense ratio ${formatPercent(expenseRatio !== undefined ? expenseRatio * 100 : undefined)}.`);
}

export function normalizeEtfSectorWeightings(payload: unknown): InstitutionalEdgeFactor | undefined {
  const rows = arrayObjects(payload);
  if (!rows.length) return undefined;
  const top = rows
    .map((item) => ({ sector: stringValue(item.sector, item.Sector, item.name), weight: numberValue(item.weightPercentage, item.percentage, item.weight) }))
    .filter((item): item is { sector: string; weight: number } => Boolean(item.sector) && item.weight !== undefined)
    .sort((left, right) => right.weight - left.weight)[0];
  if (!top) return undefined;
  const status: LayerStatus = top.weight >= 40 ? "Bearish" : top.weight >= 25 ? "Neutral" : "Bullish";
  return edgeFactor("ETF Exposure", status, `Largest ETF sector exposure is ${top.sector} at ${formatPercent(top.weight)}.`);
}

function normalizeGradesConsensus(payload: unknown): { status: LayerStatus; detail: string } | undefined {
  const item = firstObject(payload);
  if (!item) return undefined;
  const strongBuy = numberValue(item.strongBuy, item.strongBuyRatings, item.strongBuyConsensus) ?? 0;
  const buy = numberValue(item.buy, item.buyRatings, item.buyConsensus) ?? 0;
  const hold = numberValue(item.hold, item.holdRatings, item.holdConsensus) ?? 0;
  const sell = numberValue(item.sell, item.sellRatings, item.sellConsensus) ?? 0;
  const strongSell = numberValue(item.strongSell, item.strongSellRatings, item.strongSellConsensus) ?? 0;
  const total = strongBuy + buy + hold + sell + strongSell;
  if (total <= 0) return undefined;
  const bullishPct = (strongBuy + buy) / total;
  const bearishPct = (sell + strongSell) / total;
  const status: LayerStatus = bearishPct >= 0.25 ? "Bearish" : bullishPct >= 0.6 ? "Bullish" : "Neutral";
  return { status, detail: `Analyst buy mix ${Math.round(bullishPct * 100)}%, sell mix ${Math.round(bearishPct * 100)}%.` };
}

function normalizePriceTarget(payload: unknown, price: number): { status: LayerStatus; detail: string } | undefined {
  const item = firstObject(payload);
  if (!item || price <= 0) return undefined;
  const target = numberValue(item.priceTargetAverage, item.targetConsensus, item.lastMonthAvgPriceTarget, item.lastQuarterAvgPriceTarget, item.mean);
  if (target === undefined) return undefined;
  const upside = ((target - price) / price) * 100;
  const status: LayerStatus = upside <= -5 ? "Bearish" : upside >= 8 ? "Bullish" : "Neutral";
  return { status, detail: `Analyst target upside ${upside.toFixed(1)}%.` };
}

function summarizeFactors(factors: InstitutionalEdgeFactor[], warnings: string[]): InstitutionalEdgeSummary {
  const rawAdjustment = factors.reduce((sum, factor) => sum + factor.adjustment, 0);
  const adjustment = Math.max(-10, Math.min(5, rawAdjustment));
  const status: LayerStatus = adjustment < 0 ? "Bearish" : adjustment > 0 ? "Bullish" : "Neutral";
  return {
    status,
    score: adjustment,
    adjustment,
    factors,
    warnings
  };
}

function edgeFactor(name: InstitutionalEdgeFactor["name"], status: LayerStatus, detail: string): InstitutionalEdgeFactor {
  const adjustment = status === "Bullish" ? 2 : status === "Bearish" ? -5 : 0;
  return { name, status, detail, adjustment };
}

function endpointPath(endpoint: EndpointId): string {
  if (endpoint === "insider-statistics") return "insider-trading/statistics";
  if (endpoint === "etf-info") return "etf/info";
  if (endpoint === "etf-sector-weightings") return "etf/sector-weightings";
  return endpoint;
}

function responseTtl(): number {
  return RESPONSE_TTL_MS;
}

function fmpUrl(baseUrl: string, path: string, params: Record<string, string>): URL {
  const root = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = new URL(path.replace(/^\/+/, ""), root);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function isUnavailableStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isPlanWarning(value: string): boolean {
  return /upgrade|plan|permission|not authorized|forbidden|subscription|limit/i.test(value);
}

function fmpPayloadWarning(payload: unknown): string | undefined {
  const item = firstObject(payload);
  return item ? stringValue(item.Note, item.Information, item["Error Message"], item.error, item.message) : undefined;
}

function isFresh(updatedAt: string, ttlMs: number, now: Date): boolean {
  const timestamp = new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now.getTime() - timestamp < ttlMs;
}

function firstObject(payload: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(payload)) return payload.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  return undefined;
}

function arrayObjects(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const first = firstObject(payload);
  return first ? [first] : [];
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "string" && ["", "none", "null", "-"].includes(value.trim().toLowerCase())) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || ["none", "null", "-"].includes(trimmed.toLowerCase())) continue;
    return trimmed;
  }
  return undefined;
}

function normalizeExpenseRatio(value: number | undefined): number | undefined {
  return value;
}

function formatValue(value: number | undefined): string {
  return value === undefined ? "unavailable" : Number(value.toFixed(2)).toString();
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "unavailable" : value.toFixed(1) + "%";
}

function formatMoney(value: number | undefined): string {
  if (value === undefined) return "unavailable";
  if (value >= 1_000_000_000_000) return "$" + (value / 1_000_000_000_000).toFixed(1) + "T";
  if (value >= 1_000_000_000) return "$" + (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return "$" + (value / 1_000_000).toFixed(0) + "M";
  return "$" + value.toFixed(0);
}
