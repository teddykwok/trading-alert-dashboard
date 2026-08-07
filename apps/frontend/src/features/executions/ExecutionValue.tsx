import { Badge } from "../../components/ui/Badge";
import { classNames } from "../../utils/classNames";
import {
  UNKNOWN_DISPLAY,
  displayDecimal,
  displayInteger,
  displayTimestamp,
  isNegative,
  shortenId,
  type DisplayValue,
} from "./executionFormat";
import type { StatusPresentation } from "./executionPresentation";

/**
 * Shared read-only presentation pieces for the execution journal.
 *
 * Unknown values render as an em dash with an explicit "Not available"
 * accessible label, so a screen reader never hears an unknown value as a
 * number and it stays visually distinct from a real zero.
 */

function unknownLabel(known: boolean) {
  return known ? undefined : "Not available";
}

export function ValueCell({ value, className }: { value: DisplayValue; className?: string }) {
  return (
    <span
      className={classNames(value.known ? "tabular-nums" : "text-slate-500", className)}
      // The exact value is always reachable even when the text is shortened.
      title={value.exact ?? "Not available"}
      aria-label={unknownLabel(value.known)}
    >
      {value.text}
    </span>
  );
}

export function DecimalValue({ value, digits }: { value: string | null; digits?: number }) {
  return <ValueCell value={displayDecimal(value, digits)} />;
}

export function IntegerValue({ value }: { value: number | null }) {
  return <ValueCell value={displayInteger(value)} />;
}

export function TimestampValue({ value }: { value: string | null }) {
  return <ValueCell value={displayTimestamp(value)} />;
}

/** Signed money: colour is a supplement, the sign itself carries the meaning. */
export function MoneyValue({ value }: { value: string | null }) {
  const display = displayDecimal(value);
  return (
    <span
      className={classNames(
        display.known ? "tabular-nums" : "text-slate-500",
        display.known && isNegative(value) ? "text-red-400" : display.known ? "text-slate-100" : ""
      )}
      title={display.exact ?? "Not available"}
      aria-label={unknownLabel(display.known)}
    >
      {display.text}
    </span>
  );
}

/** Long ids are shortened for layout but stay fully copyable. */
export function CopyableId({ value, label }: { value: string | null; label: string }) {
  const display = shortenId(value);
  if (!display.known) {
    return (
      <span className="text-slate-500" aria-label="Not available">
        {UNKNOWN_DISPLAY}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="max-w-full break-all rounded px-1 text-left font-mono text-xs text-slate-300 hover:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title={display.exact ?? undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(display.exact ?? "");
      }}
    >
      <span className="sr-only">{`Copy ${label}: `}</span>
      {display.text}
    </button>
  );
}

/**
 * Status badge. The label always carries the meaning in text, so status is
 * never communicated by colour alone; critical states additionally get a
 * textual marker.
 */
export function StatusBadge({ presentation }: { presentation: StatusPresentation | null }) {
  if (!presentation) {
    return (
      <span className="text-slate-500" aria-label="Not available">
        {UNKNOWN_DISPLAY}
      </span>
    );
  }
  return (
    <Badge tone={presentation.tone} title={presentation.unknown ? "Unrecognised status value" : undefined}>
      {presentation.critical ? "! " : ""}
      {presentation.label}
      {presentation.unknown ? " (unrecognised)" : ""}
    </Badge>
  );
}

/** A labelled planned/actual row. */
export function FieldRow({
  label,
  children,
  emphasis,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={classNames(
        "flex items-baseline justify-between gap-3 border-b border-surface-border/60 py-1.5 last:border-b-0",
        emphasis ? "font-semibold" : ""
      )}
    >
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-right text-sm text-slate-100">{children}</dd>
    </div>
  );
}
