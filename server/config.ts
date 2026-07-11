import "dotenv/config";

const publicUrl = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "";
const localClientOrigin = "http://127.0.0.1:5173";
const localCallbackUrl = "https://127.0.0.1:4173/api/schwab/callback";
const isProduction = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 4173),
  host: process.env.HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
  isProduction,
  clientOrigin: process.env.CLIENT_ORIGIN ?? (publicUrl || localClientOrigin),
  databaseUrl: process.env.DATABASE_URL ?? "",
  schwabAppKey: process.env.SCHWAB_APP_KEY ?? "",
  schwabAppSecret: process.env.SCHWAB_APP_SECRET ?? "",
  schwabCallbackUrl: process.env.SCHWAB_CALLBACK_URL ?? (publicUrl ? `${publicUrl}/api/schwab/callback` : localCallbackUrl),
  httpsEnabled: (process.env.API_HTTPS ?? (isProduction ? "false" : "true")) !== "false",
  httpsKeyPath: process.env.API_HTTPS_KEY_PATH ?? "certs/localhost-key.pem",
  httpsCertPath: process.env.API_HTTPS_CERT_PATH ?? "certs/localhost-cert.pem",
  schwabAuthBaseUrl: process.env.SCHWAB_AUTH_BASE_URL ?? "https://api.schwabapi.com/v1/oauth",
  schwabMarketDataBaseUrl: process.env.SCHWAB_MARKET_DATA_BASE_URL ?? "https://api.schwabapi.com/marketdata/v1",
  fmpApiKey: process.env.FMP_API_KEY ?? "",
  fmpBaseUrl: process.env.FMP_BASE_URL ?? "https://financialmodelingprep.com/stable",
  fmpMaxCallsPerScan: Number(process.env.FMP_MAX_CALLS_PER_SCAN ?? 1000),
  fmpInstitutionalEdgeEnabled: (process.env.FMP_INSTITUTIONAL_EDGE_ENABLED ?? "true") !== "false",
  fmpStarterSafeMode: (process.env.FMP_STARTER_SAFE_MODE ?? "true") !== "false",
  fmpInstitutionalEdgeMaxCallsPerScan: Number(process.env.FMP_INSTITUTIONAL_EDGE_MAX_CALLS_PER_SCAN ?? 250),
  fmpInstitutionalEdgeProbeTtlHours: Number(process.env.FMP_INSTITUTIONAL_EDGE_PROBE_TTL_HOURS ?? 24),
  quantDataApiKey: process.env.QUANTDATA_API_KEY ?? "",
  quantDataBaseUrl: process.env.QUANTDATA_BASE_URL ?? "https://api.quantdata.us",
  quantDataEnabled: (process.env.QUANTDATA_ENABLED ?? "true") !== "false",
  quantDataMaxCallsPerScan: Number(process.env.QUANTDATA_MAX_CALLS_PER_SCAN ?? 300),
  quantDataCacheTtlMinutes: Number(process.env.QUANTDATA_CACHE_TTL_MINUTES ?? 15),
  etfSymbols: process.env.ETF_SYMBOLS ?? ""
};
