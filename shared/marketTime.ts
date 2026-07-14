export function isCompletedRegularSessionDate(candleDate: string, asOf: Date): boolean {
  const market = easternDateTime(asOf);
  if (candleDate < market.date) return true;
  if (candleDate > market.date) return false;
  return market.minutes >= 16 * 60;
}

function easternDateTime(value: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    minutes: Number(read("hour")) * 60 + Number(read("minute"))
  };
}
