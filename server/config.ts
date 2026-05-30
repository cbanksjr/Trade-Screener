import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4173),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:5173",
  schwabAppKey: process.env.SCHWAB_APP_KEY ?? "",
  schwabAppSecret: process.env.SCHWAB_APP_SECRET ?? "",
  schwabCallbackUrl: process.env.SCHWAB_CALLBACK_URL ?? "https://127.0.0.1:4173/api/schwab/callback",
  httpsEnabled: (process.env.API_HTTPS ?? "true") !== "false",
  httpsKeyPath: process.env.API_HTTPS_KEY_PATH ?? "certs/localhost-key.pem",
  httpsCertPath: process.env.API_HTTPS_CERT_PATH ?? "certs/localhost-cert.pem",
  schwabAuthBaseUrl: process.env.SCHWAB_AUTH_BASE_URL ?? "https://api.schwabapi.com/v1/oauth",
  schwabMarketDataBaseUrl: process.env.SCHWAB_MARKET_DATA_BASE_URL ?? "https://api.schwabapi.com/marketdata/v1"
};
