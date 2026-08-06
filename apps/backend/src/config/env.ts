import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().min(1).default("http://localhost:5173"),
  // OPTIONAL base URL for dashboard links shared OUTSIDE the app (e.g.
  // Telegram messages opened on a phone). Leave unset/empty when the
  // dashboard is only reachable locally: notifications then omit the link
  // section entirely instead of sending an unopenable localhost URL (see
  // utils/dashboard-url.ts, which also treats loopback hosts as "not public").
  PUBLIC_DASHBOARD_URL: z.string().optional().default(""),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  SCREENSHOT_STORAGE_DIR: z.string().min(1).default("src/storage/screenshots"),
  AI_VISION_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_VISION_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // "true"/"false" rather than z.coerce.boolean() — coerce.boolean() treats
  // any non-empty string (including the literal "false") as true.
  AI_VISION_FALLBACK_TO_MOCK: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  AI_VISION_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5_000_000),
  DUPLICATE_SUPPRESSION_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // --- Bounded data retention (see modules/retention) ---
  // The dashboard is a short-lived inspection window; Excel (outside this app)
  // is the permanent record. Retention deletes old screenshots first, then old
  // terminal alerts, on a daily schedule run by the worker process.
  DATA_RETENTION_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value === "true"),
  SCREENSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(3),
  ALERT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  DATA_CLEANUP_CRON: z.string().min(1).default("0 3 * * *"),
  DATA_CLEANUP_TIMEZONE: z.string().min(1).default("Asia/Singapore"),
  // Dashboard list paging: default page size when the client sends no limit,
  // and the hard cap a client may request. 100 is a PAGE, not the accessible
  // history — older retained alerts are reachable via offset paging.
  DASHBOARD_DEFAULT_LIMIT: z.coerce.number().int().positive().default(100),
  DASHBOARD_MAX_LIMIT: z.coerce.number().int().positive().default(200),
  // Rate limiting is split into two policies (see plugins/rate-limit.ts):
  //
  // Private dashboard reads + screenshot statics. A single dashboard load can
  // issue one /screenshots/* request per alert card (hundreds), so this budget
  // must comfortably absorb several page loads — it is NOT a security control,
  // the dashboard is private (Tailscale) and unauthenticated traffic never
  // reaches it.
  DASHBOARD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(2000),
  DASHBOARD_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  // Public TradingView webhook. This IS a security control: it is internet
  // facing via the Cloudflare tunnel, so it keeps its own strict budget and
  // can never be exhausted by (or exhaust) dashboard traffic.
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  WEBHOOK_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  BINANCE_REST_BASE_URL: z.string().min(1).default("https://api.binance.com"),
  // USD-M futures REST host, used for TradingView ".P" perpetual symbols
  // (GET /fapi/v1/klines). Spot keeps using BINANCE_REST_BASE_URL.
  BINANCE_FUTURES_REST_BASE_URL: z.string().min(1).default("https://fapi.binance.com"),
  // --- Binance READ-ONLY connector (Phase 2 of the automation roadmap) ---
  // Strictly read-only: the client can only issue GET requests to an
  // allowlisted set of USDⓈ-M endpoints (see modules/binance). It is not
  // wired into the alert pipeline and cannot trade. Keys are optional while
  // disabled so startup never demands credentials for the default setup.
  BINANCE_READ_ONLY_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  // Binance rejects recvWindow above 60000 ms; 5000 is the documented default.
  BINANCE_RECV_WINDOW_MS: z.coerce.number().int().positive().max(60_000).default(5000),
  // Reserved for future non-Binance crypto providers; today only "binance" is
  // wired up (see market-data.service.ts). CRYPTO alerts on any other value
  // fall back to mock candles, same as STOCK alerts.
  MARKET_DATA_PROVIDER: z.enum(["binance"]).default("binance"),
  // "true"/"false" rather than z.coerce.boolean() — coerce.boolean() treats
  // any non-empty string (including the literal "false") as true.
  MARKET_DATA_FALLBACK_TO_MOCK: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // "true"/"false" rather than z.coerce.boolean() — coerce.boolean() treats
  // any non-empty string (including the literal "false") as true.
  TELEGRAM_NOTIFICATIONS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  TELEGRAM_SEND_SCREENSHOT: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value === "true"),
  TELEGRAM_NOTIFY_ON_FAILED: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // Skip the Telegram notification when aiConfidence is below this (0..1).
  // 0 (default) means always notify regardless of confidence.
  TELEGRAM_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0),
}).superRefine((value, ctx) => {
  // Fail fast at startup rather than silently at the first alert: a real
  // OpenAI vision provider is useless without an API key.
  if (value.AI_VISION_PROVIDER === "openai" && !value.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENAI_API_KEY"],
      message: "OPENAI_API_KEY is required when AI_VISION_PROVIDER=openai",
    });
  }

  // Credentials are only required once the read-only connector is switched
  // on. With BINANCE_READ_ONLY_ENABLED=false (the default) the backend starts
  // with no Binance keys at all.
  if (value.BINANCE_READ_ONLY_ENABLED) {
    if (!value.BINANCE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BINANCE_API_KEY"],
        message: "BINANCE_API_KEY is required when BINANCE_READ_ONLY_ENABLED=true",
      });
    }
    if (!value.BINANCE_API_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BINANCE_API_SECRET"],
        message: "BINANCE_API_SECRET is required when BINANCE_READ_ONLY_ENABLED=true",
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
