import { Badge } from "../ui/Badge";
import type { SignalType } from "../../types/alert";

const SIGNAL_TONE: Record<SignalType, "green" | "red" | "yellow" | "gray"> = {
  LONG: "green",
  SHORT: "red",
  WATCH: "yellow",
  EXIT: "gray",
};

export function SignalBadge({ signal }: { signal: SignalType }) {
  return <Badge tone={SIGNAL_TONE[signal]}>{signal}</Badge>;
}
