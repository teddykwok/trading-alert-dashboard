import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { AssetsPage } from "./pages/AssetsPage";
import { RiskTemplatesPage } from "./pages/RiskTemplatesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ExecutionsPage } from "./pages/ExecutionsPage";
import { ExecutionDetailPage } from "./pages/ExecutionDetailPage";
import { TradingControlPage } from "./pages/TradingControlPage";
import { SignalQualityPage } from "./pages/SignalQualityPage";

export function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/alerts/:id" element={<AlertDetailPage />} />
        {/* Not linked from the sidebar — kept reachable by URL for debugging. */}
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/risk-templates" element={<RiskTemplatesPage />} />
        <Route path="/executions" element={<ExecutionsPage />} />
        <Route path="/executions/:executionId" element={<ExecutionDetailPage />} />
        <Route path="/trading-control" element={<TradingControlPage />} />
        {/* Monitoring only: the Native signal-quality observatory (read-only, no execution authority). */}
        <Route path="/signal-quality" element={<SignalQualityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppLayout>
  );
}
