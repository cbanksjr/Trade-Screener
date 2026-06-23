import { describe, expect, it } from "vitest";
import { createFmpFallback, normalizeFmpEarnings, normalizeFmpEarningsCalendar, normalizeFmpProfile, normalizeFmpSector, type FmpCache } from "./fmp";

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
      sector: "Information Technology"
    });
  });

  it("normalizes FMP sectors to GICS sector keys", () => {
    expect(normalizeFmpSector("Technology")).toBe("Information Technology");
    expect(normalizeFmpSector("Healthcare")).toBe("Health Care");
    expect(normalizeFmpSector("Financial Services")).toBe("Financials");
    expect(normalizeFmpSector("Consumer Cyclical")).toBe("Consumer Discretionary");
    expect(normalizeFmpSector("Consumer Defensive")).toBe("Consumer Staples");
    expect(normalizeFmpSector("Basic Materials")).toBe("Materials");
    expect(normalizeFmpSector("Energy")).toBe("Energy");
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
      { date: "2026-07-10" },
      { symbol: "MSFT", date: "2026-07-01" }
    ], "AAPL", new Date("2026-06-20T12:00:00Z"))).toBe("2026-07-25");
  });

  it("builds next earnings dates from a shared calendar response", () => {
    const calendar = normalizeFmpEarningsCalendar([
      { symbol: "AAPL", date: "2026-05-01" },
      { symbol: "MSFT", date: "2026-07-01" },
      { symbol: "AAPL", date: "2026-07-25" },
      { symbol: "AAPL", date: "2026-10-25" },
      { symbol: "OTHER", date: "2026-07-10" }
    ], ["AAPL", "MSFT"], new Date("2026-06-20T12:00:00Z"));

    expect([...calendar.entries()]).toEqual([
      ["MSFT", "2026-07-01"],
      ["AAPL", "2026-07-25"]
    ]);
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

  it("fetches next earnings when fresh cached profile lacks earnings", async () => {
    const requests: string[] = [];
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      cache: {
        AAPL: {
          updatedAt: "2026-06-20T12:00:00.000Z",
          data: { symbol: "AAPL", beta: 1.1, marketCap: 3_000_000_000_000, sector: "Information Technology" }
        }
      },
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        requests.push(url.pathname + "?" + [...url.searchParams.keys()].sort().join(","));
        return new Response(JSON.stringify([
          { symbol: "MSFT", date: "2026-07-01" },
          { symbol: "AAPL", date: "2026-07-25" }
        ]));
      }
    });

    const result = await fallback.enrich("AAPL", { nextEarningsDate: true });

    expect(requests).toEqual(["/stable/earnings?apikey,symbol"]);
    expect(result.data).toMatchObject({ nextEarningsDate: "2026-07-25" });
    expect(fallback.cache().AAPL.data).toMatchObject({
      sector: "Information Technology",
      nextEarningsDate: "2026-07-25"
    });
  });

  it("uses exact-symbol earnings fallback and ignores other symbols", async () => {
    const requests: string[] = [];
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        requests.push(url.pathname);
        return new Response(JSON.stringify([
          { symbol: "MSFT", date: "2026-07-01" },
          { symbol: "AAPL", date: "2026-10-25" },
          { symbol: "AAPL", date: "2026-07-25" },
          { symbol: "AAPL", date: "2026-05-01" }
        ]));
      }
    });

    const result = await fallback.enrich("AAPL", { nextEarningsDate: true });

    expect(requests).toEqual(["/stable/earnings"]);
    expect(result.warnings).toEqual([]);
    expect(result.data?.nextEarningsDate).toBe("2026-07-25");
  });

  it("warns when exact-symbol earnings fallback has no future date", async () => {
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify([
        { symbol: "MSFT", date: "2026-07-01" },
        { symbol: "AAPL", date: "2026-05-01" }
      ]))
    });

    const result = await fallback.enrich("AAPL", { nextEarningsDate: true });

    expect(result.data).toBeUndefined();
    expect(result.warnings).toEqual(["Next earnings date unavailable from FMP."]);
  });

  it("loads a shared earnings calendar once and updates matching cached symbols", async () => {
    const requests: string[] = [];
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        requests.push(url.pathname + "?" + [...url.searchParams.keys()].sort().join(","));
        return new Response(JSON.stringify([
          { symbol: "AAPL", date: "2026-07-25" },
          { symbol: "MSFT", date: "2026-07-01" },
          { symbol: "OTHER", date: "2026-07-10" }
        ]));
      }
    });

    const result = await fallback.earningsCalendar(["AAPL", "MSFT"]);

    expect(requests).toEqual(["/stable/earnings-calendar?apikey,from,to"]);
    expect([...result.earningsBySymbol.entries()]).toEqual([
      ["MSFT", "2026-07-01"],
      ["AAPL", "2026-07-25"]
    ]);
    expect(result.usedLive).toBe(true);
    expect(fallback.remainingCalls()).toBe(0);
    expect(fallback.cache().AAPL.data.nextEarningsDate).toBe("2026-07-25");
    expect(fallback.cache().MSFT.data.nextEarningsDate).toBe("2026-07-01");
  });

  it("fetches profile when fresh cached earnings lacks sector", async () => {
    const requests: string[] = [];
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      cache: {
        AAPL: {
          updatedAt: "2026-06-20T12:00:00.000Z",
          data: { symbol: "AAPL", nextEarningsDate: "2026-07-25" }
        }
      },
      now: () => new Date("2026-06-20T13:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        requests.push(url.pathname);
        return new Response(JSON.stringify([{
          symbol: "AAPL",
          companyName: "Apple Inc.",
          beta: "1.2",
          marketCap: "3000000000000",
          sector: "Technology"
        }]));
      }
    });

    const result = await fallback.enrich("AAPL", { sector: true });

    expect(requests).toEqual(["/stable/profile"]);
    expect(result.data).toMatchObject({ companyName: "Apple Inc.", sector: "Information Technology" });
    expect(fallback.cache().AAPL.data).toMatchObject({
      sector: "Information Technology",
      nextEarningsDate: "2026-07-25"
    });
  });

  it("returns clear warnings for rate-limited earnings responses without caching them as valid", async () => {
    const fallback = createFmpFallback({
      apiKey: "test",
      baseUrl: "https://example.test/stable",
      maxCalls: 1,
      fetchImpl: async () => new Response(JSON.stringify({ error: "rate limit" }), { status: 429 })
    });

    const result = await fallback.enrich("AAPL", { nextEarningsDate: true });

    expect(result.data).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("rate limited");
    expect(fallback.cache().AAPL).toBeUndefined();
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
