import { describe, expect, it } from "vitest";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { buildFmpUniverse, isLastDayOfMonth, loadRefreshedUniverse, parseFmpConstituents, parseNasdaq100Symbols, parseSp500Constituents, parseSp500Symbols, resolveDefaultUniverseSymbols, type UniverseCache } from "./universe";

describe("default universe refresh helpers", () => {
  it("parses S&P 500 symbols from the public table markup", () => {
    const symbols = parseSp500Symbols('<table id="constituents"><tr><td><a href="/wiki/3M">MMM</a></td></tr><tr><td><a href="/wiki/Apple">AAPL</a></td></tr></table>');

    expect(symbols).toEqual(["AAPL", "MMM"]);
  });

  it("parses S&P 500 GICS sector data from the public table markup", () => {
    const constituents = parseSp500Constituents(`
      <table id="constituents">
        <tr><td><a href="/wiki/Apple">AAPL</a></td><td>Apple Inc.</td><td>Information Technology</td></tr>
        <tr><td><a href="/wiki/JPMorgan_Chase">JPM</a></td><td>JPMorgan Chase</td><td>Financials</td></tr>
      </table>
    `);

    expect(constituents.symbols).toEqual(["AAPL", "JPM"]);
    expect(constituents.sectorBySymbol).toEqual({
      AAPL: "Information Technology",
      JPM: "Financials"
    });
  });

  it("parses Nasdaq 100 symbols from public stock rows", () => {
    const symbols = parseNasdaq100Symbols('<a href="/stocks/nvda/">NVDA</a><a href="/stocks/msft/">MSFT</a>');

    expect(symbols).toEqual(["MSFT", "NVDA"]);
  });

  it("parses FMP constituent symbols and sectors", () => {
    const constituents = parseFmpConstituents([
      { symbol: "aapl", name: "Apple Inc.", sector: "Technology" },
      { Symbol: "MSFT", Sector: "Technology" },
      { symbol: "bad-symbol!" },
      { name: "Missing symbol" }
    ]);

    expect(constituents.symbols).toEqual(["AAPL", "MSFT"]);
    expect(constituents.sectorBySymbol).toEqual({
      AAPL: "Information Technology",
      MSFT: "Information Technology"
    });
  });

  it("builds a de-duped FMP S&P 500 + Nasdaq universe with sector data", () => {
    const universe = buildFmpUniverse([
      { symbol: "AAPL", sector: "Technology" },
      { symbol: "MSFT", sector: "Technology" }
    ], [
      { symbol: "MSFT", sector: "Technology" },
      { symbol: "NVDA", sector: "Technology" }
    ]);

    expect(universe.symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(universe.source).toBe("FMP S&P 500 + Nasdaq constituent endpoints");
    expect(universe.sectorBySymbol).toMatchObject({
      AAPL: "Information Technology",
      MSFT: "Information Technology",
      NVDA: "Information Technology"
    });
  });

  it("falls back to public sources when the FMP universe is incomplete", async () => {
    const requests: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("sp500-constituent")) return jsonResponse([{ symbol: "AAPL", sector: "Technology" }]);
      if (url.includes("nasdaq-constituent")) return jsonResponse([]);
      if (url.includes("wikipedia.org")) return textResponse(publicSp500Html(451));
      if (url.includes("stockanalysis.com")) return textResponse('<a href="/stocks/zzzz/">ZZZZ</a>');
      return textResponse("", 404);
    };

    const universe = await loadRefreshedUniverse(fetchImpl, true);

    expect(universe.source).toBe("public S&P 500 + Nasdaq 100 pages");
    expect(universe.symbols.length).toBeGreaterThanOrEqual(450);
    expect(requests.some((url) => url.includes("sp500-constituent"))).toBe(true);
    expect(requests.some((url) => url.includes("wikipedia.org"))).toBe(true);
  });

  it("uses cached public-source symbols when the cache is complete enough", () => {
    const cached: UniverseCache = {
      symbols: Array.from({ length: 451 }, (_, index) => "ZZ" + String(index).padStart(3, "A")).sort(),
      updatedAt: "2026-05-30T00:00:00.000Z",
      source: "test public source",
      added: [],
      removed: []
    };

    expect(resolveDefaultUniverseSymbols(cached)).toBe(cached.symbols);
  });

  it("falls back to the bundled universe when the cache is missing or incomplete", () => {
    expect(resolveDefaultUniverseSymbols()).toBe(defaultUniverseSymbols);
    expect(resolveDefaultUniverseSymbols({
      symbols: ["AAPL"],
      updatedAt: "2026-05-30T00:00:00.000Z",
      source: "partial source",
      added: [],
      removed: []
    })).toBe(defaultUniverseSymbols);
  });

  it("identifies the final calendar day of a month", () => {
    expect(isLastDayOfMonth(new Date("2026-05-31T12:00:00Z"))).toBe(true);
    expect(isLastDayOfMonth(new Date("2026-05-30T12:00:00Z"))).toBe(false);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function textResponse(payload: string, status = 200): Response {
  return new Response(payload, { status });
}

function publicSp500Html(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => {
    const symbol = generatedSymbol(index);
    return "<tr><td><a href=\"/wiki/" + symbol + "\">" + symbol + "</a></td><td>" + symbol + " Corp</td><td>Information Technology</td></tr>";
  }).join("");
  return "<table id=\"constituents\">" + rows + "</table>";
}

function generatedSymbol(index: number): string {
  return "T" + String.fromCharCode(65 + Math.floor(index / 26)) + String.fromCharCode(65 + index % 26);
}
