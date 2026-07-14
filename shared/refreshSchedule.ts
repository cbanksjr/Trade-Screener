export const MARKET_TIME_ZONE = "America/Chicago";
export const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const marketClock = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

export function isMarketRefreshWindow(date = new Date()): boolean {
  const parts = Object.fromEntries(marketClock.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = parts.weekday;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!weekday || !["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)) return false;
  const minutesAfterMidnight = hour * 60 + minute;
  return minutesAfterMidnight >= 8 * 60 + 30 && minutesAfterMidnight <= 15 * 60;
}
