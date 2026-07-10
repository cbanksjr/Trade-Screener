import { describe, expect, it } from "vitest";
import { isMarketRefreshWindow, isRefreshDue } from "./refreshSchedule";

describe("free-tier refresh schedule", () => {
  it("runs only during the weekday 8:30am-3:00pm Central market window", () => {
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:29:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:30:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:00:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:01:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-11T15:00:00.000Z"))).toBe(false);
  });

  it("treats missing, invalid, and elapsed timestamps as due", () => {
    const now = new Date("2026-07-10T15:00:00.000Z").getTime();
    expect(isRefreshDue(undefined, now)).toBe(true);
    expect(isRefreshDue("invalid", now)).toBe(true);
    expect(isRefreshDue("2026-07-10T14:59:59.000Z", now)).toBe(true);
    expect(isRefreshDue("2026-07-10T15:00:01.000Z", now)).toBe(false);
  });
});
