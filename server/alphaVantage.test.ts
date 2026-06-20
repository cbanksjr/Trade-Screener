import { describe, expect, it } from "vitest";
import { createAlphaVantageFallback, normalizeAlphaVantageOverview, parseAlphaVantageEarningsCalendar, type AlphaVantageCache } from "./alphaVantage";

describe("AlphaVantage fallback fundamentals", () => {
  it("normalizes overview numeric strings and core fields", () => {
    expect(normalizeAlphaVantageOverview({
      Symbol: "MSFT",
      Name: "Microsoft Corporation",
      Beta: "0.91",
      MarketCapitalization: "3050000000000",
      Sector: "Technology"
    })).toEqual({
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      beta: 0.91,
      marketCap: 3050000000000,
      sector: "Technology"
    });
  });

  it("treats None and empty overview values as unavailable", () => {
    expect(normalizeAlphaVantageOverview({
      Symbol: "MISS",
      Name: "",
      Beta: "None",
      MarketCapitalization: "",
      Sector: "-"
    })).toBeUndefined();
  });

  it("throws readable errors for rate-limit payloads", () => {
    expect(() => normalizeAlphaVantageOverview({
      Note: "Thank you for using Alpha Vantage. Our standard API rate limit is 25 requests per day."
    })).toThrow("standard API rate limit");
  });

  it("parses the next future earnings date from CSV", () => {
    const csv = [
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency",
      "AAPL,Apple Inc,2026-05-01,2026-03-31,1.20,USD",
      "AAPL,Apple Inc,2026-07-25,2026-06-30,1.40,USD"
    ].join("\n");

    expect(parseAlphaVantageEarningsCalendar(csv, "AAPL", new Date("2026-06-20T12:00:00Z"))).toBe("2026-07-25");
  });

  it("reuses fresh cached data without spending live calls", async () => {
    let calls = 0;
    const cache: AlphaVantageCache = {
      AAPL: {
        updatedAt: "2026-06-20T12:00:00.000Z",
        data: { symbol: "AAPL", beta: 1.22, marketCap: 3100000000000 }
      }
    };
    const fallback = createAlphaVantageFallback({
      apiKey: "test",
      baseUrl: "https://example.test/query",
      maxCalls: 1,
      cache,
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}");
      }
    });

    const result = await fallback.enrich("AAPL", { beta: true, marketCap: true });

    expect(calls).toBe(0);
    expect(result.data).toMatchObject({ beta: 1.22, marketCap: 3100000000000 });
    expect(fallback.remainingCalls()).toBe(1);
  });

  it("refreshes stale cached data and updates the cache", async () => {
    const fallback = createAlphaVantageFallback({
      apiKey: "test",
      baseUrl: "https://example.test/query",
      maxCalls: 1,
      cache: {
        AAPL: {
          updatedAt: "2026-06-18T12:00:00.000Z",
          data: { symbol: "AAPL", beta: 1.1 }
        }
      },
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        Symbol: "AAPL",
        Beta: "1.44",
        MarketCapitalization: "3200000000000"
      }))
    });

    const result = await fallback.enrich("AAPL", { beta: true, marketCap: true });

    expect(result.data).toMatchObject({ beta: 1.44, marketCap: 3200000000000 });
    expect(fallback.isDirty()).toBe(true);
    expect(fallback.cache().AAPL.data.beta).toBe(1.44);
  });

  it("returns warnings instead of throwing on malformed live responses", async () => {
    const fallback = createAlphaVantageFallback({
      apiKey: "test",
      baseUrl: "https://example.test/query",
      maxCalls: 1,
      fetchImpl: async () => new Response("not-json")
    });

    const result = await fallback.enrich("BAD", { beta: true });

    expect(result.data).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("malformed JSON");
  });
});
