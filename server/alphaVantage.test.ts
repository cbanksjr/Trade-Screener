import { describe, expect, it } from "vitest";
import { normalizeAlphaVantageEarningsCalendar, normalizeAlphaVantageOverview, normalizeAlphaVantageResponse } from "./alphaVantage";

describe("Alpha Vantage fundamentals", () => {
  it("normalizes populated company overview data", () => {
    expect(normalizeAlphaVantageOverview({
      Symbol: "msft",
      Name: "Microsoft Corporation",
      MarketCapitalization: "3050000000000",
      Beta: "0.91",
      EPS: "12.34",
      PERatio: "33.2",
      DividendPerShare: "3.32",
      DividendYield: "0.0081",
      ExDividendDate: "2026-05-15",
      DividendDate: "2026-06-11"
    })).toEqual({
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      marketCap: 3050000000000,
      beta: 0.91,
      eps: 12.34,
      peRatio: 33.2,
      dividendAmount: 3.32,
      dividendYield: 0.81,
      explicitZeroDividend: false,
      dividendExDate: "2026-05-15",
      dividendPayDate: "2026-06-11"
    });
  });

  it("returns a provider warning for rate-limit or informational payloads", () => {
    const result = normalizeAlphaVantageResponse({ Note: "API call frequency exceeded." });
    expect(result.warning).toContain("Alpha Vantage");
    expect(result.overview).toBeUndefined();
  });

  it("preserves explicit zero dividend fields", () => {
    expect(normalizeAlphaVantageOverview({
      Symbol: "TSLA",
      Name: "Tesla Inc",
      DividendPerShare: "0",
      DividendYield: "0"
    })).toMatchObject({
      symbol: "TSLA",
      dividendAmount: 0,
      dividendYield: 0,
      explicitZeroDividend: true
    });
  });

  it("returns a provider warning when overview data is empty", () => {
    const result = normalizeAlphaVantageResponse({});
    expect(result.warning).toBe("Alpha Vantage did not return company overview data.");
    expect(result.overview).toBeUndefined();
  });

  it("normalizes the nearest 12-month earnings calendar report date", () => {
    const result = normalizeAlphaVantageEarningsCalendar([
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency",
      "MSFT,Microsoft Corporation,2099-04-20,2099-03-31,3.10,USD",
      "MSFT,Microsoft Corporation,2099-01-25,2098-12-31,3.00,USD"
    ].join("\n"), "MSFT");

    expect(result).toEqual({ nextEarningsDate: "2099-01-25" });
  });

  it("returns a provider warning when earnings calendar has no future date", () => {
    const result = normalizeAlphaVantageEarningsCalendar("symbol,name,reportDate\nMSFT,Microsoft,2000-01-01", "MSFT");
    expect(result.warning).toContain("future earnings date");
  });
});
