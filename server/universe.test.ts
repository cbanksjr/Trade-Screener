import { describe, expect, it } from "vitest";
import { defaultUniverseSymbols } from "./defaultUniverse";
import { isLastDayOfMonth, parseNasdaq100Symbols, parseSp500Symbols, resolveDefaultUniverseSymbols, type UniverseCache } from "./universe";

describe("default universe refresh helpers", () => {
  it("parses S&P 500 symbols from the public table markup", () => {
    const symbols = parseSp500Symbols('<table id="constituents"><tr><td><a href="/wiki/3M">MMM</a></td></tr><tr><td><a href="/wiki/Apple">AAPL</a></td></tr></table>');

    expect(symbols).toEqual(["AAPL", "MMM"]);
  });

  it("parses Nasdaq 100 symbols from public stock rows", () => {
    const symbols = parseNasdaq100Symbols('<a href="/stocks/nvda/">NVDA</a><a href="/stocks/msft/">MSFT</a>');

    expect(symbols).toEqual(["MSFT", "NVDA"]);
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
