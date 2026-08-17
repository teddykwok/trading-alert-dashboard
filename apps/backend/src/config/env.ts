import "dotenv/config";
import { z } from "zod";
// Dependency-free pure module: safe to import here, and the single home of the
// role-specific protection working types.
import {
  DEFAULT_PROTECTION_PRICE_PROTECT,
  DEFAULT_STOP_WORKING_TYPE,
  DEFAULT_TAKE_PROFIT_WORKING_TYPE,
  PROTECTION_WORKING_TYPES,
} from "../modules/execution/protection-policy";

/**
 * Decimal-string config values. Validated as plain decimal literals and kept
 * as strings so decimal.js receives the exact configured value — no float
 * parsing anywhere on the authoritative path.
 */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

const positiveDecimalString = z
  .string()
  .trim()
  .regex(DECIMAL_PATTERN, "must be a plain decimal string, e.g. \"2.5\"")
  .refine((value) => /[1-9]/.test(value), "must be greater than zero");

const nonNegativeDecimalString = z
  .string()
  .trim()
  .regex(DECIMAL_PATTERN, "must be a plain decimal string, e.g. \"0.5\"");

/**
 * Compares two validated non-negative decimal strings digit-wise (no float
 * conversion). Returns -1, 0 or 1.
 */
export function compareDecimalStrings(a: string, b: string): number {
  const [aInt, aFrac = ""] = a.trim().split(".");
  const [bInt, bFrac = ""] = b.trim().split(".");

  const intWidth = Math.max(aInt.length, bInt.length);
  const fracWidth = Math.max(aFrac.length, bFrac.length);
  const left = aInt.padStart(intWidth, "0") + aFrac.padEnd(fracWidth, "0");
  const right = bInt.padStart(intWidth, "0") + bFrac.padEnd(fracWidth, "0");

  if (left === right) return 0;
  return left < right ? -1 : 1;
}

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
  // --- Phase 11A.1 execution profile identity --------------------------------
  // Which ExecutionProfile the production orchestrator uses, together with
  // BINANCE_FUTURES_REST_BASE_URL's environment. A NON-SECRET operator-chosen
  // alias (e.g. "primary-futures") — never an API key, secret or account number.
  // Empty (the default) means no profile is selected, and the orchestrator
  // fails closed rather than picking an arbitrary database row.
  EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: z.string().optional().default(""),
  EXECUTION_PROFILE_ENVIRONMENT: z.enum(["TESTNET", "MAINNET"]).default("TESTNET"),
  // How many non-terminal executions one reconciliation tick may process.
  EXECUTION_RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(10),

  // --- Phase 10 operator maintenance gates (fail-closed) ---------------------
  // Strict enum, not `=== "true"`: a typo like "TRUE" or "1" fails startup
  // rather than silently reading as false, which is the behaviour you want from
  // a switch that authorizes a POST against a real account.
  //
  // Each gate authorizes EXACTLY the one operation it names and nothing else.
  // Neither has any influence on live entry: turning both on still leaves
  // EXECUTION_LIVE_ENTRY_ENABLED and EXECUTION_PROTECTION_READY closed, so no
  // real trade can be placed.
  //
  // Authorizes POST /fapi/v1/positionSide/dual (HEDGE only), and only after the
  // account-wide zero-position / zero-open-order preflight passes.
  BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Authorizes POST /fapi/v1/order/test — Binance's NON-MATCHING validation
  // endpoint. It never reaches the order book and never creates an order.
  BINANCE_TEST_ORDER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // --- Phase 3 dynamic leverage / isolated margin policy (calculation only) ---
  // Kept as decimal STRINGS: they feed decimal.js directly and must never be
  // round-tripped through a JS float. Target is the preferred isolated margin
  // (risk × multiplier); maximum is a hard capital ceiling.
  BINANCE_TARGET_MARGIN_MULTIPLIER: positiveDecimalString.default("2.5"),
  BINANCE_MAX_MARGIN_MULTIPLIER: positiveDecimalString.default("3.333333"),
  // Liquidation must sit at least stopDistance × ratio beyond the stop loss.
  BINANCE_LIQUIDATION_BUFFER_RATIO: nonNegativeDecimalString.default("0.5"),
  // User-side automation leverage ceiling. The engine's usable maximum is
  // min(bracket initialLeverage, this). Capped at 125 — the highest initial
  // leverage Binance currently publishes in USDⓈ-M brackets — so a typo like
  // 250 cannot silently promise an unusable leverage.
  BINANCE_MAX_AUTOMATION_LEVERAGE: z.coerce.number().int().positive().max(125).default(25),
  // --- Phase 5 safety & capacity (fail-closed canary limits) ---------------
  // TRUE means the global kill switch is ACTIVE and every NEW admission is
  // rejected. It never cancels orders, closes positions or changes existing
  // execution status — it only blocks new admissions.
  // Fails closed: unset means ACTIVE, and only the exact string "false" can
  // release it — a typo can never accidentally enable admissions.
  EXECUTION_GLOBAL_KILL_SWITCH: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  EXECUTION_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(1),
  EXECUTION_MAX_PENDING_ENTRIES: z.coerce.number().int().positive().default(1),
  EXECUTION_MAX_TOTAL_ACTIVE_TRADES: z.coerce.number().int().positive().default(1),
  // Monetary limits stay decimal STRINGS — never parsed through a JS float.
  EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: positiveDecimalString.default("1.50"),
  EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD: positiveDecimalString.default("5.00"),
  EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE: z.coerce.number().int().positive().default(1),
  EXECUTION_MAX_ALERT_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  // Tolerance for a signal timestamp slightly ahead of local time (clock skew).
  EXECUTION_SIGNAL_FUTURE_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(5),
  // --- Phase 6 live entry gates (BOTH must be true to mutate) ---------------
  // Same strict enum as the kill switch: unset or malformed is a hard failure
  // or a closed gate, never an accidental "on".
  EXECUTION_LIVE_ENTRY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Phase 7 protection does not exist yet, so this stays false and no real
  // entry can be placed even if live entry is switched on.
  EXECUTION_PROTECTION_READY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  EXECUTION_ENTRY_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  EXECUTION_ENTRY_RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  EXECUTION_ENTRY_RECONCILE_DELAY_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  // --- Phase 7 protection, margin top-up and emergency close ---------------
  // Every default is fail-closed. Adding isolated margin is a real balance
  // movement, so it stays off until deliberately enabled.
  EXECUTION_AUTO_ADD_MARGIN_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // DISABLED: never send a MARKET close — park for a human instead.
  // ON_UNVERIFIED_STOP: last-resort close when the stop cannot be verified.
  EXECUTION_EMERGENCY_CLOSE_MODE: z.enum(["DISABLED", "ON_UNVERIFIED_STOP"]).default("DISABLED"),
  EXECUTION_PROTECTION_RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  EXECUTION_PROTECTION_RECONCILE_DELAY_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  // Both legs trigger on the traded CONTRACT_PRICE, so protection fires against
  // the same feed the chart levels came from. The names and defaults come from
  // modules/execution/protection-policy so the schema and the shared resolver
  // used by the testnet verifier cannot drift apart.
  EXECUTION_SL_WORKING_TYPE: z.enum(PROTECTION_WORKING_TYPES).default(DEFAULT_STOP_WORKING_TYPE),
  EXECUTION_TP_WORKING_TYPE: z.enum(PROTECTION_WORKING_TYPES).default(DEFAULT_TAKE_PROFIT_WORKING_TYPE),
  EXECUTION_PROTECTION_PRICE_PROTECT: z
    .enum(["true", "false"])
    .default(DEFAULT_PROTECTION_PRICE_PROTECT ? "true" : "false")
    .transform((value) => value === "true"),
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
  // Phase 9. OPTIONAL separate destination for execution milestone messages so
  // trade-execution noise can be kept out of the signal chat. Empty (the
  // default) falls back to TELEGRAM_CHAT_ID. There is deliberately no second
  // bot token: the same TELEGRAM_BOT_TOKEN sends to both chats.
  TELEGRAM_EXECUTION_CHAT_ID: z.string().optional().default(""),
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

  // A Telegram chat id is either a numeric id (negative for groups/channels)
  // or an @public_name. Rejecting anything else at startup — the same
  // fail-fast convention used above — turns a typo into an immediate, obvious
  // error instead of a silently undelivered execution notification. The value
  // itself is never echoed back in the message.
  if (value.TELEGRAM_EXECUTION_CHAT_ID !== "" && !/^(-?\d{1,32}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value.TELEGRAM_EXECUTION_CHAT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TELEGRAM_EXECUTION_CHAT_ID"],
      message: "TELEGRAM_EXECUTION_CHAT_ID must be a numeric chat id or an @channel name",
    });
  }

  // The maximum isolated margin is a ceiling above the preferred target, so
  // it can never be the smaller of the two. Compared as decimal strings via
  // padded numeric comparison to avoid float parsing.
  if (compareDecimalStrings(value.BINANCE_MAX_MARGIN_MULTIPLIER, value.BINANCE_TARGET_MARGIN_MULTIPLIER) < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BINANCE_MAX_MARGIN_MULTIPLIER"],
      message: "BINANCE_MAX_MARGIN_MULTIPLIER must be greater than or equal to BINANCE_TARGET_MARGIN_MULTIPLIER",
    });
  }

  // A total-active cap below either individual cap would be silently
  // unreachable, which hides a misconfiguration — reject it outright.
  if (value.EXECUTION_MAX_TOTAL_ACTIVE_TRADES < value.EXECUTION_MAX_OPEN_POSITIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXECUTION_MAX_TOTAL_ACTIVE_TRADES"],
      message: "EXECUTION_MAX_TOTAL_ACTIVE_TRADES must be >= EXECUTION_MAX_OPEN_POSITIONS",
    });
  }
  if (value.EXECUTION_MAX_TOTAL_ACTIVE_TRADES < value.EXECUTION_MAX_PENDING_ENTRIES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXECUTION_MAX_TOTAL_ACTIVE_TRADES"],
      message: "EXECUTION_MAX_TOTAL_ACTIVE_TRADES must be >= EXECUTION_MAX_PENDING_ENTRIES",
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
