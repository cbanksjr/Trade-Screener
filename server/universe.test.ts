import { describe, expect, it } from "vitest";
import { isLastDayOfMonth, parseNasdaq100Symbols, parseSp500Symbols } from "./universe";

describe("default universe refresh helpers", () => {
  it("parses S&P 500 symbols from the public table markup", () => {
    const symbols = parseSp500Symbols('<table id="constituents"><tr><td><a href="/wiki/3M">MMM</a></td></tr><tr><td><a href="/wiki/Apple">AAPL</a></td></tr></table>');

    expect(symbols).toEqual(["AAPL", "MMM"]);
  });

  it("parses Nasdaq 100 symbols from public stock rows", () => {
    const symbols = parseNasdaq100Symbols('<a href="/stocks/nvda/">NVDA</a><a href="/stocks/msft/">MSFT</a>');

    expect(symbols).toEqual(["MSFT", "NVDA"]);
  });

  it("identifies the final calendar day of a month", () => {
    expect(isLastDayOfMonth(new Date("2026-05-31T12:00:00Z"))).toBe(true);
    expect(isLastDayOfMonth(new Date("2026-05-30T12:00:00Z"))).toBe(false);
  });
});
