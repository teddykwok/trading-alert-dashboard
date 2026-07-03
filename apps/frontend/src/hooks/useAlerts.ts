import { useCallback, useEffect, useState } from "react";
import { alertsApi } from "../api/alerts.api";
import type { Alert } from "../types/alert";
import type { AlertListQuery } from "../types/api";

export function useAlerts(filters: AlertListQuery) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await alertsApi.list(filters);
      setAlerts(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { alerts, setAlerts, total, loading, error, refetch };
}
