import React from "react";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";
import type { Candle } from "../shared/types";

type ThemeMode = "light" | "dark";

type CandlestickChartProps = {
  candles: Candle[];
  entryArea?: string;
  stopPrice?: number | null;
  target1?: number | null;
  target2?: number | null;
  symbol: string;
  theme: ThemeMode;
};

function parseEntryPrice(value: string | undefined): number | null {
  const matches = value?.match(/\d[\d,]*(?:\.\d+)?/g)?.map((item) => Number(item.replaceAll(",", ""))).filter(Number.isFinite) ?? [];
  if (!matches.length) return null;
  return matches.reduce((sum, item) => sum + item, 0) / matches.length;
}

function emaSeries(candles: Candle[], length: number): LineData<Time>[] {
  if (!candles.length) return [];
  const multiplier = 2 / (length + 1);
  let ema = candles[0].close;
  return candles.map((candle, index) => {
    ema = index === 0 ? candle.close : candle.close * multiplier + ema * (1 - multiplier);
    return { time: candle.date.slice(0, 10) as Time, value: ema };
  });
}

// Trailing window of daily candles rendered on the chart. The most recent bars that
// fit the container are anchored to the right; the remainder scroll into view. Keeping
// this generous (rather than a fixed on-screen count) seeds the EMAs well before the
// visible region.
const CHART_CANDLE_WINDOW = 120;

export function CandlestickChart({ candles, entryArea, stopPrice, target1, target2, symbol, theme }: CandlestickChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    const validCandles = candles.filter((candle) => (
      Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close)
    ));
    if (!container || validCandles.length < 2) return;

    const visibleCandles = validCandles.slice(-CHART_CANDLE_WINDOW);
    const ema8Data = emaSeries(validCandles, 8).slice(-CHART_CANDLE_WINDOW);
    const ema21Data = emaSeries(validCandles, 21).slice(-CHART_CANDLE_WINDOW);

    const dark = theme === "dark";
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: dark ? "#8399a6" : "#637582",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? "rgba(43, 65, 78, .42)" : "rgba(159, 177, 188, .34)" },
        horzLines: { color: dark ? "rgba(43, 65, 78, .42)" : "rgba(159, 177, 188, .34)" },
      },
      rightPriceScale: {
        borderColor: dark ? "#243746" : "#d7e1e8",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: dark ? "#243746" : "#d7e1e8",
        timeVisible: false,
        rightOffset: 3,
        // A fixed integer bar spacing keeps every bar on whole-pixel boundaries so the
        // 1px wick renders centered on the body. Do NOT pair this with an explicit
        // setVisibleLogicalRange() — a fractional range forces fractional bar widths and
        // pushes wicks off-center (they drift to the left edge of the body).
        barSpacing: 12,
        minBarSpacing: 6,
      },
      crosshair: {
        vertLine: { color: dark ? "#507080" : "#8da5b3", labelBackgroundColor: dark ? "#173847" : "#dceff1" },
        horzLine: { color: dark ? "#507080" : "#8da5b3", labelBackgroundColor: dark ? "#173847" : "#dceff1" },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const upColor = dark ? "#59d8a0" : "#168a64";
    const downColor = dark ? "#fb7185" : "#d7485f";
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor,
      downColor,
      // Solid single-color candles: wick matches the body and borders are off. The old
      // lighter wick/border tints made bodies read as hollow outlined bars.
      wickUpColor: upColor,
      wickDownColor: downColor,
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    candleSeries.setData(visibleCandles.map((candle) => ({
      time: candle.date.slice(0, 10) as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })) as CandlestickData<Time>[]);

    const ema8 = chart.addSeries(LineSeries, {
      color: dark ? "#62a7ff" : "#2563eb",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    ema8.setData(ema8Data);

    const ema21 = chart.addSeries(LineSeries, {
      color: dark ? "#fbbf24" : "#d97706",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    ema21.setData(ema21Data);

    const entry = parseEntryPrice(entryArea);
    if (entry !== null) candleSeries.createPriceLine({ price: entry, color: dark ? "#49d7c2" : "#0f8d7d", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Entry" });
    if (typeof stopPrice === "number") candleSeries.createPriceLine({ price: stopPrice, color: dark ? "#fb7185" : "#d7485f", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Stop" });
    if (typeof target1 === "number") candleSeries.createPriceLine({ price: target1, color: dark ? "#59d8a0" : "#168a64", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "T1" });
    if (typeof target2 === "number") candleSeries.createPriceLine({ price: target2, color: dark ? "#7dd3fc" : "#1678a8", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "T2" });

    // Anchor to the most recent bars; the fixed barSpacing above decides how many fit.
    // `autoSize: true` gives the chart its own resize handling, so no manual
    // ResizeObserver (and no fractional setVisibleLogicalRange) is needed here.
    chart.timeScale().scrollToRealTime();

    return () => {
      chart.remove();
    };
  }, [candles, entryArea, stopPrice, symbol, target1, target2, theme]);

  if (candles.length < 2) {
    return <div className="chart-empty">Price history is unavailable for this setup.</div>;
  }

  return <div className="candlestick-chart" ref={containerRef} role="img" aria-label={`${symbol} daily candlestick chart with 8 EMA, 21 EMA, and trade levels`} />;
}
