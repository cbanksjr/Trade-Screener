import { describe, expect, it } from "vitest";
import { AUTO_REFRESH_INTERVAL_MS, isMarketRefreshWindow, isRefreshDue } from "./refreshSchedule";

describe("market window schedule", () => {
  it("matches only the weekday 8:30am-3:00pm Central market window", () => {
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:29:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:30:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:00:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:01:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-11T15:00:00.000Z"))).toBe(false);
  });
});

describe("15-minute refresh cadence", () => {
  it("does not refresh early and becomes due exactly at the interval", () => {
    const startedAt = 1_000;
    expect(isRefreshDue(startedAt, startedAt + AUTO_REFRESH_INTERVAL_MS - 1)).toBe(false);
    expect(isRefreshDue(startedAt, startedAt + AUTO_REFRESH_INTERVAL_MS)).toBe(true);
  });
});
