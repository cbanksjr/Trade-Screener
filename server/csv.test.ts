import { describe, expect, it } from "vitest";
import { importFundamentalsCsv } from "./csv";
import { getFundamentals, initDb } from "./sqlite";

describe("fundamentals CSV importer", () => {
  initDb();

  it("imports a Thinkorswim-style comma separated watchlist export", () => {
    const result = importFundamentalsCsv([
      "Symbol,LAST,BETA,MARKET_CAP,AVG_VOLUME",
      "TOSAAA,123.45,1.25,12.5B,6000000"
    ].join("\n"));

    const stored = getFundamentals().get("TOSAAA");
    expect(result.imported).toBe(1);
    expect(stored?.marketCap).toBe(12_500_000_000);
    expect(stored?.avgDollarVolume20d).toBe(740_700_000);
  });

  it("imports a Thinkorswim-style tab separated export", () => {
    const result = importFundamentalsCsv([
      "Symbol\tMark\tBeta\tMarket Cap\tAvg Vol",
      "TOSBBB\t250\t0.95\t3.1T\t10000000"
    ].join("\n"));

    const stored = getFundamentals().get("TOSBBB");
    expect(result.imported).toBe(1);
    expect(stored?.marketCap).toBe(3_100_000_000_000);
    expect(stored?.avgDollarVolume20d).toBe(2_500_000_000);
  });

  it("imports a symbol-only Thinkorswim watchlist as a prequalified universe", () => {
    const result = importFundamentalsCsv([
      "Symbol,Description",
      "TOSCCC,Pre-screened candidate"
    ].join("\n"));

    const stored = getFundamentals().get("TOSCCC");
    expect(result.imported).toBe(1);
    expect(stored?.symbol).toBe("TOSCCC");
    expect(stored?.beta).toBeUndefined();
    expect(stored?.marketCap).toBeUndefined();
  });

  it("imports the Watchlist Scanner export format with a preamble", () => {
    const result = importFundamentalsCsv([
      "\uFEFFWatchlist Scanner",
      "",
      "Results",
      "Symbol,Description,Last,Net Chng,%Change,Volume,Bid,Ask,High,Low,EPS,Market Cap,Vol Index",
      "TOSDDD,MICROSOFT CORP,416.03,-2.54,-0.61%,\"30,398,049\",413.92,414.03,419.77,413.02,16.79,\"3,090,452 M\",30.72%"
    ].join("\n"));

    const stored = getFundamentals().get("TOSDDD");
    expect(result.imported).toBe(1);
    expect(stored?.marketCap).toBe(3_090_452_000_000);
    expect(stored?.avgDollarVolume20d).toBeCloseTo(12_646_500_325.47, 2);
  });
});
