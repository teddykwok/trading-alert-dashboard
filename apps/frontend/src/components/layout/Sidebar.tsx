import { NavLink } from "react-router-dom";
import { classNames } from "../../utils/classNames";

// Assets is intentionally not listed: the /assets route still exists for
// manual/debugging access, but day-to-day workflow is signals-only.
const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/settings", label: "Settings" },
];

export function Sidebar() {
  return (
    <aside className="hidden w-56 flex-shrink-0 border-r border-surface-border bg-surface-raised md:block">
      <div className="px-4 py-5">
        <p className="text-sm font-bold tracking-tight text-slate-100">Trading Alerts</p>
        <p className="text-xs text-slate-500">Live signal dashboard</p>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              classNames(
                "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive ? "bg-blue-600/15 text-blue-400" : "text-slate-400 hover:bg-surface-border hover:text-slate-200"
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
