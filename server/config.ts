import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4173),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:5173",
  tradierToken: process.env.TRADIER_TOKEN ?? "",
  tradierBaseUrl: process.env.TRADIER_BASE_URL ?? "https://api.tradier.com/v1"
};
