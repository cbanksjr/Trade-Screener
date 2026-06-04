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
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY ?? "",
  alphaVantageBaseUrl: process.env.ALPHA_VANTAGE_BASE_URL ?? "https://www.alphavantage.co/query"
};
