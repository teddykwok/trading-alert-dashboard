import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

/**
 * The visible (client) width of a horizontally scrolling container, kept
 * current as it resizes. A wide table's expanded detail row uses it to stay
 * exactly as wide as what is on screen — pinned to the left edge — instead of
 * as wide as the table, where part of it would sit off-screen.
 *
 * null until measured, and always null where ResizeObserver does not exist
 * (server rendering, tests): the detail then simply takes its natural width.
 */
export function useVisibleWidth<T extends HTMLElement>(): [RefCallback<T>, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

/** Inline style for a detail panel inside a cell with `inset` px of horizontal padding on each side. */
export function pinnedDetailStyle(visibleWidth: number | null, inset: number): { width: number } | undefined {
  return visibleWidth === null ? undefined : { width: Math.max(0, visibleWidth - 2 * inset) };
}
