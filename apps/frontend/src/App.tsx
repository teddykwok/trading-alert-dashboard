import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { AssetsPage } from "./pages/AssetsPage";
import { RiskTemplatesPage } from "./pages/RiskTemplatesPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/alerts/:id" element={<AlertDetailPage />} />
        {/* Not linked from the sidebar — kept reachable by URL for debugging. */}
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/risk-templates" element={<RiskTemplatesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppLayout>
  );
}
