import { Badge } from "../ui/Badge";

/**
 * Marks analysis produced by the real OpenAI vision provider. Render only
 * when `alert.aiProvider === "openai"`.
 */
export function OpenAiBadge() {
  return <Badge tone="green">OpenAI Vision</Badge>;
}
