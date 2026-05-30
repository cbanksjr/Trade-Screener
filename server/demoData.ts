import type { Candle, Fundamentals, OptionContract } from "../shared/types";

const fundamentals: Record<string, Fundamentals> = {
  AAPL: { symbol: "AAPL", beta: 1.12, marketCap: 3_100_000_000_000, avgDollarVolume20d: 8_500_000_000 },
  MSFT: { symbol: "MSFT", beta: 0.94, marketCap: 3_250_000_000_000, avgDollarVolume20d: 7_200_000_000 },
  NVDA: { symbol: "NVDA", beta: 1.75, marketCap: 2_900_000_000_000, avgDollarVolume20d: 35_000_000_000 },
  META: { symbol: "META", beta: 1.18, marketCap: 1_300_000_000_000, avgDollarVolume20d: 9_800_000_000 },
  AMD: { symbol: "AMD", beta: 1.82, marketCap: 250_000_000_000, avgDollarVolume20d: 7_100_000_000 },
  AMZN: { symbol: "AMZN", beta: 1.09, marketCap: 2_000_000_000_000, avgDollarVolume20d: 10_900_000_000 },
  GOOGL: { symbol: "GOOGL", beta: 1.04, marketCap: 2_100_000_000_000, avgDollarVolume20d: 6_700_000_000 },
  TSLA: { symbol: "TSLA", beta: 2.28, marketCap: 650_000_000_000, avgDollarVolume20d: 18_600_000_000 }
};

export function demoFundamental(symbol: string): Fundamentals | undefined {
  return fundamentals[symbol.toUpperCase()];
}

export function demoCandles(symbol: string): Candle[] {
  const seed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const base = 90 + (seed % 150);
  const candles: Candle[] = [];
  let close = base;
  for (let index = 0; index < 180; index += 1) {
    const trend = index * 0.16;
    const wave = Math.sin((index + seed) / 8) * 4 + Math.cos((index + seed) / 15) * 2;
    const squeeze = index > 135 && index < 165 ? Math.sin(index) * 0.9 : wave;
    close = base + trend + squeeze;
    if (symbol === "TSLA") close = base + index * 0.03 + Math.sin(index / 4) * 10;
    const open = close - Math.sin(index / 3) * 1.2;
    const high = Math.max(open, close) + 1.3 + Math.abs(Math.sin(index)) * 1.8;
    const low = Math.min(open, close) - 1.3 - Math.abs(Math.cos(index)) * 1.8;
    candles.push({
      date: dateBack(180 - index),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: 20_000_000 + (seed % 20) * 1_000_000 + Math.round(Math.abs(Math.sin(index / 5)) * 8_000_000)
    });
  }
  return candles;
}

export function demoOptions(symbol: string, price: number): OptionContract[] {
  return [
    ...demoDirectionalOptions(symbol, price, "call", [0.98, 1.02, 1.05, 1.1, 1.15]),
    ...demoDirectionalOptions(symbol, price, "put", [1.02, 0.98, 0.95, 0.9, 0.85])
  ];
}

function demoDirectionalOptions(symbol: string, price: number, optionType: "call" | "put", multipliers: number[]): OptionContract[] {
  return multipliers.map((multiplier, index) => {
    const expirationDate = dateBack(-60 - index * 25);
    const strike = Math.round((price * multiplier) / 5) * 5;
    const intrinsic = optionType === "call" ? price - strike : strike - price;
    const bid = Math.max(0.35, intrinsic * 0.25 + 4.5 - index * 0.35);
    const ask = bid * (1.04 + index * 0.015);
    const volume = 900 - index * 120;
    const openInterest = 3200 - index * 360;
    const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
    const optionCode = optionType === "call" ? "C" : "P";
    const optionName = optionType === "call" ? "Call" : "Put";
    return {
      symbol: `${symbol}${expirationDate.replaceAll("-", "").slice(2)}${optionCode}${String(strike * 1000).padStart(8, "0")}`,
      description: `${symbol} ${expirationDate} ${strike} ${optionName}`,
      expirationDate,
      strike,
      optionType,
      bid: round(bid),
      ask: round(ask),
      last: round((bid + ask) / 2),
      volume,
      openInterest,
      delta: round((optionType === "call" ? 0.62 : -0.62) + (optionType === "call" ? -index * 0.07 : index * 0.07)),
      spreadPct: round(spreadPct),
      score: Math.max(40, 95 - index * 8 - spreadPct)
    };
  });
}

function dateBack(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
