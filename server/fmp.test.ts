import { describe, expect, it } from "vitest";
import { createFmpFallback, normalizeFmpEarnings, normalizeFmpProfile, type FmpCache } from "./fmp";

describe("FMP fallback fundamentals", () => {
  it("normalizes profile numeric strings and core fields", () => {
    expect(normalizeFmpProfile([{
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      beta: "0.91",
      mktCap: "3050000000000",
      sector: "Technology"
    }])).toEqual({
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      beta: 0.91,
      marketCap: 3050000000000,
      sector: "Technology"
    });
  });

  it("treats None and empty profile values as unavailable", () => {
    expect(normalizeFmpProfile([{
      symbol: "MISS",
      companyName: "",
      beta: "None",
      mktCap: "",
      sector: "-"
    }])).toBeUndefined();
  });

  it("throws readable errors for limit payloads", () => {
    expect(() => normalizeFmpProfile({
      "Error Message": "Limit Reach. Please upgrade your plan or visit pricing to increase your limit."
    })).toThrow("Limit Reach");
  });

  it("selects the next future earnings date", () => {
    expect(normalizeFmpEarnings([
      { symbol: "AAPL", date: "2026-05-01" },
      { symbol: "AAPL", date: "2026-07-25" },
      { symbol: "MSFT", date: "2026-07-01" }
    ], "AAPL", new Date("2026-06-20T12:00:00Z"))).toBe("2026-07-25");
  });

  it("reuses fresh cached data without spending live calls", async () => {
    let calls = 0;
    const cache: FmpCache = {
      AAPL: {
        updatedAt: "2026-06-20T12:00:00.000Z",
        data: { symbol: "AAPL", beta: 1.22, marketCap: 3100000000000 }
      }
    };
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
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
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      cache: {
        AAPL: {
          updatedAt: "2026-06-18T12:00:00.000Z",
          data: { symbol: "AAPL", beta: 1.1 }
        }
      },
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify([{
        symbol: "AAPL",
        beta: "1.44",
        mktCap: "3200000000000"
      }]))
    });

    const result = await fallback.enrich("AAPL", { beta: true, marketCap: true });

    expect(result.data).toMatchObject({ beta: 1.44, marketCap: 3200000000000 });
    expect(fallback.isDirty()).toBe(true);
    expect(fallback.cache().AAPL.data.beta).toBe(1.44);
  });

  it("returns warnings instead of throwing on malformed live responses", async () => {
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      fetchImpl: async () => new Response("not-json")
    });

    const result = await fallback.enrich("BAD", { beta: true });

    expect(result.data).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("malformed JSON");
  });
});
