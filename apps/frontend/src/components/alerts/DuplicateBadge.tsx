import { Badge } from "../ui/Badge";

/**
 * Shown when an alert has been re-fired one or more times within the
 * backend's duplicate suppression window (see DUPLICATE_SUPPRESSION_WINDOW_SECONDS).
 * Those re-fires don't create new alerts — they just bump this count.
 */
export function DuplicateBadge({ count }: { count: number }) {
  return <Badge tone="gray">×{count} duplicate{count === 1 ? "" : "s"}</Badge>;
}
