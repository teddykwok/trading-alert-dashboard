import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { classNames } from "../../utils/classNames";

export interface TabDefinition {
  id: string;
  label: string;
}

interface TabListProps {
  tabs: TabDefinition[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label: string;
}

/**
 * Minimal WAI-ARIA tab list built from the existing design tokens (no new UI
 * framework). Roving tabindex: only the active tab is in the tab order, and
 * Arrow/Home/End move between tabs — the standard pattern screen-reader and
 * keyboard users expect.
 */
export function TabList({ tabs, activeId, onChange, label }: TabListProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number) {
    const bounded = (index + tabs.length) % tabs.length;
    onChange(tabs[bounded].id);
    refs.current[bounded]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        focusTab(index - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        focusTab(index + 1);
        break;
      case "Home":
        event.preventDefault();
        focusTab(0);
        break;
      case "End":
        event.preventDefault();
        focusTab(tabs.length - 1);
        break;
    }
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-surface-border"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={classNames(
              "-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
              active
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  id: string;
  activeId: string;
}

/**
 * Mounts on first activation and then STAYS mounted, hidden with CSS while
 * inactive. That keeps each panel's unsaved form input and loaded data intact
 * across tab switches, and means a panel's API calls happen once — never on
 * every switch, and never before the tab is first opened.
 */
export function TabPanel({ id, activeId, children }: PropsWithChildren<TabPanelProps>) {
  const active = id === activeId;
  const [everActive, setEverActive] = useState(active);

  useEffect(() => {
    if (active) setEverActive(true);
  }, [active]);

  if (!everActive) return null;

  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      className={active ? "flex flex-col gap-5" : "hidden"}
    >
      {children}
    </div>
  );
}
