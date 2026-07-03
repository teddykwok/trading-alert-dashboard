import { useEffect, useRef } from "react";
import { createChart, ColorType, LineStyle, type UTCTimestamp } from "lightweight-charts";
import type { SignalType } from "../../types/alert";

interface MiniSignalChartProps {
  seed: string;
  price: number;
  signal: SignalType;
  height?: number;
}

const SIGNAL_COLOR: Record<SignalType, string> = {
  LONG: "#4ade80",
  SHORT: "#f87171",
  WATCH: "#facc15",
  EXIT: "#94a3b8",
};

function seededRandom(seed: string) {
  let value = Array.from(seed).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) || 1;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
}

/**
 * Small decorative sparkline for alert cards. It does not reflect real
 * market history (the dashboard doesn't fetch OHLCV client-side) — it's a
 * deterministic-per-alert visual cue for the terminal aesthetic.
 */
export function MiniSignalChart({ seed, price, signal, height = 56 }: MiniSignalChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#64748b" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
    });

    const series = chart.addLineSeries({
      color: SIGNAL_COLOR[signal],
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const random = seededRandom(seed);
    const points = Array.from({ length: 30 }, (_, i) => {
      const drift = (random() - 0.48) * price * 0.01;
      return { time: i, value: price + drift * (30 - i) };
    }).map((point, index, arr) => ({ ...point, value: index === arr.length - 1 ? price : point.value }));

    series.setData(points.map((p, i) => ({ time: (i + 1) as UTCTimestamp, value: p.value })));
    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [seed, price, signal, height]);

  return <div ref={containerRef} style={{ height }} />;
}
