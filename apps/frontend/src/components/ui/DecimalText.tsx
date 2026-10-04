import { compactDecimal } from "../../utils/formatDecimal";

/**
 * An exact decimal string rendered compactly, with the EXACT value in the
 * tooltip and in `data-exact`. Display only: the value itself is never changed.
 * `break-all` keeps even an unexpected long value from overflowing its card.
 */
export function DecimalText({ value, className = "" }: { value: string; className?: string }) {
  const shown = compactDecimal(value);
  return (
    <span className={`break-all ${className}`.trim()} title={shown.exact} data-exact={shown.exact} data-shortened={shown.shortened ? "true" : "false"}>
      {shown.text}
      {shown.shortened && <span className="text-slate-500">…</span>}
    </span>
  );
}
