import { Badge } from "../ui/Badge";

/**
 * Flags analysis produced by the mock AI Vision provider so it's never
 * mistaken for real, signal-aware AI output. Render only when
 * `alert.aiProvider === "mock"`.
 */
export function MockAiBadge() {
  return <Badge tone="yellow">Mock AI</Badge>;
}
