import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getSocket } from "../../sockets/socket";
import { classNames } from "../../utils/classNames";
import { OperatorAccountSelector } from "../operator/OperatorAccountSelector";

export function Topbar() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    setConnected(socket.connected);

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, []);

  return (
    <header className="flex items-center justify-between border-b border-surface-border bg-surface-raised px-4 py-3 md:px-6">
      {/* Mobile nav — mirrors the sidebar's items (Assets stays URL-only). */}
      <nav className="flex gap-3 md:hidden">
        <NavLink to="/" className="text-sm text-slate-300">
          Dashboard
        </NavLink>
        <NavLink to="/risk-templates" className="text-sm text-slate-300">
          Risk Templates
        </NavLink>
        <NavLink to="/settings" className="text-sm text-slate-300">
          Settings
        </NavLink>
      </nav>

      {/* The persistent account target for Trading Control. Presentation only:
          each account keeps its own control plane, credentials and gates. */}
      <div className="ml-auto mr-4 hidden md:block">
        <OperatorAccountSelector />
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span
          className={classNames(
            "h-2 w-2 rounded-full",
            connected ? "bg-green-500" : "bg-red-500"
          )}
        />
        {connected ? "Live" : "Disconnected"}
      </div>
    </header>
  );
}
