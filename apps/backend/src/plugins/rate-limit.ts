import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env";

/**
 * In-memory rate limiting with two deliberately separate policies. Good enough
 * for a personal single-instance deployment; swap for a Redis store if this
 * ever runs behind multiple nodes.
 *
 * 1. GLOBAL (this registration) — private dashboard reads and the
 *    /screenshots/* statics. Every alert card renders one screenshot request,
 *    so a single dashboard load costs ~1 request per alert in the window
 *    (hundreds). A small budget here 429s normal navigation, which is why
 *    DASHBOARD_RATE_LIMIT_MAX is generous. This is a runaway-loop guard, not a
 *    security boundary: the dashboard is private (Tailscale) and every request
 *    through it shares one proxy IP, so all browsing lands in one bucket.
 *
 * 2. PER-ROUTE (routes/webhook.routes.ts) — the public TradingView webhook
 *    overrides this global budget with its own strict one, so internet-facing
 *    traffic is limited independently and dashboard browsing can never consume
 *    the webhook's budget (or vice versa).
 *
 * Both policies are env-tunable; see config/env.ts.
 */
export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    max: env.DASHBOARD_RATE_LIMIT_MAX,
    timeWindow: env.DASHBOARD_RATE_LIMIT_WINDOW,
  });
});
