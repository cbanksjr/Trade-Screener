import { upsertFundamental } from "./sqlite";

export type ImportFundamentalsResult = {
  imported: number;
  skipped: number;
  errors: string[];
};

export function importFundamentalsCsv(csv: string): ImportFundamentalsResult {
  const cleanedCsv = csv.replace(/^\uFEFF/, "");
  const lines = cleanedCsv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { imported: 0, skipped: 0, errors: ["CSV must include a header row and at least one data row."] };
  const headerLineIndex = findHeaderLineIndex(lines);
  if (headerLineIndex < 0) {
    return { imported: 0, skipped: lines.length, errors: ["Could not find a Symbol or Ticker header row in the CSV."] };
  }
  const delimiter = detectDelimiter(lines[headerLineIndex]);
  const headers = splitDelimitedLine(lines[headerLineIndex], delimiter).map(normalizeHeader);
  const symbolIndex = findHeader(headers, ["symbol", "ticker", "underlying", "instrument"]);
  const betaIndex = findHeader(headers, ["beta"]);
  const marketCapIndex = findHeader(headers, ["marketcap", "marketcapitalization", "mktcap", "capitalization"]);
  const advIndex = findHeader(headers, ["avgdollarvolume20d", "averagedollarvolume", "dollarvolume", "avgdollarvolume", "averagedailyvalue"]);
  const avgVolumeIndex = findHeader(headers, [
    "avgvolume",
    "averagevolume",
    "avgdailyvolume",
    "averagedailyvolume",
    "volumeavg",
    "avgvol",
    "volavg",
    "volumeaverage",
    "volume"
  ]);
  const priceIndex = findHeader(headers, ["price", "last", "lastprice", "close", "mark", "markprice", "bidaskmark"]);
  if (symbolIndex < 0) {
    throw new Error("CSV must include a Symbol or Ticker column. Thinkorswim exports can use Symbol, Last/Mark, and Avg Volume columns.");
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const line of lines.slice(headerLineIndex + 1)) {
    const cols = splitDelimitedLine(line, delimiter);
    const symbol = cleanSymbol(cols[symbolIndex]);
    const beta = betaIndex >= 0 ? numberFromCsv(cols[betaIndex]) : undefined;
    const marketCap = marketCapIndex >= 0 ? numberFromCsv(cols[marketCapIndex]) : undefined;
    const avgDollarVolume20d = resolveDollarVolume(cols, advIndex, avgVolumeIndex, priceIndex);
    if (!symbol) {
      skipped += 1;
      if (errors.length < 5) errors.push("Skipped row because symbol was missing.");
      continue;
    }
    upsertFundamental(symbol, finiteOrUndefined(beta), finiteOrUndefined(marketCap), avgDollarVolume20d);
    imported += 1;
  }
  return { imported, skipped, errors };
}

function findHeader(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function findHeaderLineIndex(lines: string[]): number {
  return lines.findIndex((line) => {
    const delimiter = detectDelimiter(line);
    const headers = splitDelimitedLine(line, delimiter).map(normalizeHeader);
    return findHeader(headers, ["symbol", "ticker", "underlying", "instrument"]) >= 0;
  });
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === "\"") quoted = !quoted;
    else if (char === delimiter && !quoted) {
      output.push(current);
      current = "";
    } else current += char;
  }
  output.push(current);
  return output;
}

function numberFromCsv(value: string | undefined): number {
  const raw = String(value ?? "")
    .replaceAll("$", "")
    .replaceAll(",", "")
    .replaceAll("%", "")
    .replace(/[()]/g, "")
    .trim()
    .toUpperCase();
  if (!raw || raw === "N/A" || raw === "--" || raw === "NAN") return Number.NaN;
  const multiplier = raw.endsWith("T") ? 1_000_000_000_000 : raw.endsWith("B") ? 1_000_000_000 : raw.endsWith("M") ? 1_000_000 : raw.endsWith("K") ? 1_000 : 1;
  const numeric = Number(raw.replace(/[TBMK]$/, ""));
  return numeric * multiplier;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectDelimiter(headerLine: string): string {
  const tabCount = (headerLine.match(/\t/g) ?? []).length;
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function cleanSymbol(value: string | undefined): string {
  return String(value ?? "")
    .replace(/^"+|"+$/g, "")
    .trim()
    .toUpperCase()
    .replace(/^\$/, "");
}

function resolveDollarVolume(cols: string[], advIndex: number, avgVolumeIndex: number, priceIndex: number): number | undefined {
  if (advIndex >= 0) {
    const explicitDollarVolume = numberFromCsv(cols[advIndex]);
    if (Number.isFinite(explicitDollarVolume)) return explicitDollarVolume;
  }
  if (avgVolumeIndex >= 0 && priceIndex >= 0) {
    const avgVolume = numberFromCsv(cols[avgVolumeIndex]);
    const price = numberFromCsv(cols[priceIndex]);
    if (Number.isFinite(avgVolume) && Number.isFinite(price)) return avgVolume * price;
  }
  return undefined;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}
