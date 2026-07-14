import { describe, expect, it } from "vitest";
import { isMarketRefreshWindow } from "./refreshSchedule";

describe("market window schedule", () => {
  it("matches only the weekday 8:30am-3:00pm Central market window", () => {
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:29:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-10T13:30:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:00:00.000Z"))).toBe(true);
    expect(isMarketRefreshWindow(new Date("2026-07-10T20:01:00.000Z"))).toBe(false);
    expect(isMarketRefreshWindow(new Date("2026-07-11T15:00:00.000Z"))).toBe(false);
  });
});
