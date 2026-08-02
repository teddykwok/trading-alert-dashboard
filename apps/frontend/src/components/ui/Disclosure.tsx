import { useState, type PropsWithChildren } from "react";

interface DisclosureProps {
  title: string;
  /** Optional muted line under the title, shown collapsed and expanded. */
  description?: string;
  defaultOpen?: boolean;
}

/**
 * Collapsible section following the "Advanced details" pattern already used
 * inside the manual risk calculator (button + aria-expanded + chevron).
 *
 * Children mount on first open and then stay mounted (hidden with CSS) so
 * collapsing never discards unsaved input or triggers a refetch on reopen.
 */
export function Disclosure({
  title,
  description,
  defaultOpen = false,
  children,
}: PropsWithChildren<DisclosureProps>) {
  const [open, setOpen] = useState(defaultOpen);
  const [everOpen, setEverOpen] = useState(defaultOpen);

  function toggle() {
    setOpen((previous) => {
      if (!previous) setEverOpen(true);
      return !previous;
    });
  }

  return (
    <div className="rounded-lg border border-surface-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-200">{title}</span>
          {description && <span className="block text-xs text-slate-500">{description}</span>}
        </span>
        <span aria-hidden="true" className="text-sm leading-none text-slate-500">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {everOpen && <div className={open ? "px-3 pb-3 pt-1" : "hidden"}>{children}</div>}
    </div>
  );
}
