import { Badge } from "../ui/Badge";
import type { AlertStatus } from "../../types/alert";

const STATUS_TONE: Record<AlertStatus, "green" | "red" | "yellow" | "gray" | "blue"> = {
  RECEIVED: "blue",
  PROCESSING_SCREENSHOT: "yellow",
  ANALYZING_WITH_AI: "yellow",
  ANALYZED: "green",
  FAILED: "red",
  IGNORED_DUPLICATE: "gray",
};

const STATUS_LABEL: Record<AlertStatus, string> = {
  RECEIVED: "Received",
  PROCESSING_SCREENSHOT: "Rendering chart",
  ANALYZING_WITH_AI: "Analyzing with AI",
  ANALYZED: "Analyzed",
  FAILED: "Failed",
  IGNORED_DUPLICATE: "Duplicate",
};

export function StatusBadge({ status }: { status: AlertStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}
