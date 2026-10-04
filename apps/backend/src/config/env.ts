// Phase 11F.1 -- NOT `import "dotenv/config"`.
//
// dotenv is no longer the first loader to touch this process: the generated
// Prisma client loads the repository `.env` at ITS module initialization, and
// neither loader overrides a key that is already set. Whichever ran first won,
// which is how a process launched with DOTENV_CONFIG_PATH could end up holding
// another account's identity and credentials. `runtime-env` owns that ordering
// and is the only place the environment is materialised.
import { ensureRuntimeEnvBootstrapped } from "./runtime-env";
import { z } from "zod";
// The CANONICAL Extreme-RR lookback vocabulary and its single membership
// test. Imported rather than re-listed: a second copy of [50,100,200,300]
// in this schema would be a second vocabulary, free to drift from the one
// the planner actually uses.
//
// No cycle is possible: @trading-alert-dashboard/shared does not depend on
// the backend. Its only runtime dependency is decimal.js, which every
// backend process already loads through the modules that import shared
// (queue.ts among them), so this changes load ORDER, not the load set.
import {
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
} from "@trading-alert-dashboard/shared";
// Dependency-free pure module: safe to import here, and the single home of the
// role-specific protection working types.
import {
  DEFAULT_PROTECTION_PRICE_PROTECT,
  DEFAULT_STOP_WORKING_TYPE,
  DEFAULT_TAKE_PROFIT_WORKING_TYPE,
  PROTECTION_WORKING_TYPES,
} from "../modules/execution/protection-policy";
// Also dependency-free at runtime: its only import is a TYPE import, which is
// erased, so naming it here adds no module cycle. Imported rather than
// re-typed so the schema and `canonicalUtcDayRoots` cannot drift apart.
import {
  MAX_INGEST_HORIZON_DAYS,
  MIN_INGEST_HORIZON_DAYS,
} from "../modules/execution/exchange-fill-day-roots";

// Materialise the environment before a single variable is read from it.
//
// An entrypoint that declared a mode has already done this and gets the
// memoised result; anything else -- a library, a test, an entrypoint not yet
// migrated -- lands here and receives exactly what `import "dotenv/config"`
// used to give it, plus a refusal in the one case that can be proven wrong.
ensureRuntimeEnvBootstrapped();

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

/**
 * Whole-number config values that must mean EXACTLY what was written.
 *
 * `z.coerce.number()` is right for an ordinary limit, and wrong here: it reads
 * "30days" as 30, "2.5" as 2.5 and "2.0" as 2, so a typo becomes a silently
 * different policy. A horizon is a count of days an operator chose, and a value
 * that had to be reinterpreted to become a number is a mistake rather than a
 * setting -- so the text is validated first and converted second. Trimmed,
 * matching the decimal-string validators above.
 */
const wholeNumberString = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be a whole number, e.g. \"30\"")
  .transform((value) => Number(value));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),
  // Phase 11F -- the ACCOUNT CONTROL plane's listener.
  //
  // No default, on purpose. The generic backend owns 4000; an account
  // control plane that defaulted anywhere would either fight it for the port
  // or appear on one nobody chose. Deployment supplies it per account, from
  // that account's own env file, and the entrypoint refuses to start without
  // it. Optional in the schema so the generic processes are unaffected.
  ACCOUNT_CONTROL_PORT: z.coerce.number().int().positive().optional(),
  // Loopback by DEFAULT. This plane holds an account's credentials and
  // performs signed reads; it must not become externally reachable just
  // because it was given a port. Exposure is an explicit act.
  ACCOUNT_CONTROL_HOST: z.string().min(1).default("127.0.0.1"),
  FRONTEND_URL: z.string().min(1).default("http://localhost:5173"),
  // OPTIONAL base URL for dashboard links shared OUTSIDE the app (e.g.
  // Telegram messages opened on a phone). Leave unset/empty when the
  // dashboard is only reachable locally: notifications then omit the link
  // section entirely instead of sending an unopenable localhost URL (see
  // utils/dashboard-url.ts, which also treats loopback hosts as "not public").
  PUBLIC_DASHBOARD_URL: z.string().optional().default(""),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  // --- Operator control credential ------------------------------------------
  // Guards the operator-only control API. Optional so an ordinary dashboard
  // install starts without one; the guard fails CLOSED when it is unset, so an
  // unconfigured deployment simply has no operator API rather than an open one.
  // Deliberately NOT the TradingView webhook secret: that value is shared with
  // an external service and travels in alert bodies.
  OPERATOR_API_TOKEN: z.string().optional().default(""),
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
  // Phase 11F -- the GLOBAL Extreme-RR plan-generation lookback.
  //
  // Since 11E an ExtremeRRPlan is generated ONCE and adopted independently
  // by every account, so the input that generates it cannot belong to an
  // account. It used to be read from the configured ExecutionProfile's
  // safety policy, which meant the shared plan was silently shaped by
  // whichever account the generating process happened to be configured for.
  //
  // Validated against the canonical vocabulary HERE, at configuration parse,
  // so an unsupported deployment value can never reach a running process.
  //
  // Without this a value like 500 passed startup, every process became
  // operational, health and attestation proofs all succeeded, and the
  // deployment only failed when the first alert tried to generate a plan --
  // long after a rollout would have been accepted. Invalid configuration
  // must fail before runtime acceptance, not during it.
  //
  // A refusal, never a coercion: silently planning at 300 would build trades
  // from a window the operator never chose.
  EXTREME_RR_LOOKBACK_CANDLES: z.coerce
    .number()
    .int()
    .positive()
    .default(300)
    .refine(isExtremeRRLookback, {
      message: `must be one of ${EXTREME_RR_LOOKBACKS.join(", ")}`,
    }),
  // --- Per-account DEFAULT Native plan lookback (display / preview only) ---
  // Which of 50/100/200/300 Account A / Account B would prefer for a Native
  // alert's frozen plan. UNSET when absent or empty. Raw strings on purpose:
  // they are resolved (and an invalid value REFUSED, never coerced) by
  // native-account-plan-policy, so a bad Native display preference can never
  // stop this process -- which also serves the TradingView webhook. Never
  // read by any execution path; Native execution stays hard-disabled.
  NATIVE_PLAN_DEFAULT_LOOKBACK_A: z.string().optional(),
  NATIVE_PLAN_DEFAULT_LOOKBACK_B: z.string().optional(),
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
  // Operator MUTATION budget, deliberately tiny. These routes arm and disarm
  // a real-money account; a human clicks them a handful of times an hour, so
  // anything larger is capacity nobody needs and an attacker might. The
  // read-only status poll keeps the generous dashboard budget.
  OPERATOR_ACTION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  OPERATOR_ACTION_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
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
  // Absolute isolated-margin FLOOR in USD, not a multiplier: a few dollars of
  // margin sits close to liquidation whatever the risk budget is, so the floor
  // must not scale with it. "0" DISABLES it and keeps closest-to-target
  // selection — the default is "0" precisely so that adding this variable
  // cannot change what an existing installation trades. Kept as a literal like
  // its neighbours (config/env does not import the shared package); a test
  // pins it to MARGIN_ENGINE_DEFAULTS.minimumMarginUsd so the two cannot drift.
  BINANCE_MIN_MARGIN_USD: nonNegativeDecimalString.default("0"),
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
  // SOFT admission target, distinct from the HARD cap above. Reaching it stops
  // NEW admissions and asks the orchestrator to cancel remaining live ENTRY
  // orders; a fill that wins the race against that cancellation is still valid
  // exposure and is protected normally, up to EXECUTION_MAX_OPEN_POSITIONS.
  // Defaulting to 1 makes soft == hard == 1, i.e. exactly today's behaviour.
  EXECUTION_SOFT_OPEN_POSITION_TARGET: z.coerce.number().int().positive().default(1),
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

  /**
   * Whether a NEWLY created take-profit lineage may be placed as a standard
   * resting LIMIT instead of a conditional TAKE_PROFIT_MARKET.
   *
   * Fail-closed, and deliberately narrow: it decides the modality of the FIRST
   * take-profit intent of an execution and nothing else. Once an execution has
   * a take-profit lineage, that lineage's modality is what every later repair
   * follows, so flipping this switch can never change the modality of a trade
   * already in flight.
   */
  EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED: z
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
  // --- Phase 6 historical fill ingestion -------------------------------------
  // How many COMPLETED UTC days of exchange fill history one root bootstrap
  // covers. The bounds are the domain's own constants, not a second copy, and
  // an out-of-range or malformed value fails STARTUP -- there is deliberately no
  // clamp, because silently ingesting 60 days when 61 was asked for is a
  // different account history than the operator requested.
  //
  // Availability only. Nothing invokes the bootstrap automatically; when and how
  // often it runs is not decided here.
  EXECUTION_FILL_INGEST_HORIZON_DAYS: wholeNumberString
    .pipe(z.number().int().min(MIN_INGEST_HORIZON_DAYS).max(MAX_INGEST_HORIZON_DAYS))
    .default("30"),
  // How many one-window executor invocations a SINGLE bounded batch may spend.
  // Not a domain constant and not imported from one: the driver independently
  // refuses anything that is not a safe integer >= 1, and this ceiling is the
  // separate operational question of how much one pass may do. Both checks
  // stand -- config is defence in depth, never a replacement.
  //
  // Deliberately NOT an exchange-request budget. Request weight is Slice 4's
  // problem and may restrict effective work further; a window bound is not a
  // rate limit and must not be read as one.
  EXECUTION_FILL_BATCH_MAX_WINDOWS: wholeNumberString
    .pipe(z.number().int().min(1).max(100))
    .default("5"),
  // How long a FUTURE scheduler should leave between batch opportunities.
  // Seconds, matching every other cadence value in this schema.
  //
  // Nothing reads this yet, and declaring it starts nothing: there is no timer,
  // no cron and no startup hook in this phase. It exists so the cadence
  // decision is written down once, in the same place as the bound it pairs
  // with, before anything is wired to obey it.
  EXECUTION_FILL_BATCH_INTERVAL_SECONDS: wholeNumberString
    .pipe(z.number().int().min(10).max(3600))
    .default("60"),
  // The Binance REQUEST_WEIGHT one bounded batch may spend on
  // GET /fapi/v1/userTrades, and on NOTHING else. It is not an account or IP
  // rate limiter: server-time syncs, orders, account reads, market data and
  // any other process are all outside it.
  //
  // One userTrades dispatch costs 5 (the documented weight pinned in
  // modules/binance/binance.endpoints.ts, which a test here holds this range
  // against). So the floor of 5 buys exactly one dispatch, the default of 25
  // matches the default 5-window batch, and the ceiling of 500 matches the
  // 100-window configuration ceiling -- the default therefore takes nothing
  // away from the batch size already configured above.
  //
  // Independent of MAX_WINDOWS by design, and never derived from it at
  // runtime: one bounds invocations, the other bounds exchange weight.
  EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT: wholeNumberString
    .pipe(z.number().int().min(5).max(500))
    .default("25"),
  // Whether a historical-fill runtime tick may run a batch at all.
  //
  // DEFAULT FALSE, and dormant even when true: turning this on does not create
  // a timer, a cron, a startup hook or any caller. NOTHING in production
  // invokes the tick runner in this phase -- the flag only decides what that
  // runner would do if something one day called it.
  //
  // Strict enum for the same reason the Phase 10 maintenance gates use one: a
  // typo like "TRUE" or "1" fails startup instead of silently reading as one
  // value or the other. This switch authorizes real signed GET
  // /fapi/v1/userTrades requests against a real account, so it must never be
  // decided by a near-miss spelling.
  //
  // Deliberately its OWN gate. EXECUTION_GLOBAL_KILL_SWITCH,
  // EXECUTION_LIVE_ENTRY_ENABLED and EXECUTION_PROTECTION_READY govern placing
  // and protecting orders; historical fill ingestion places nothing and is
  // read-only, so reusing a trading gate would either block a safe read or,
  // far worse, let opening the trading gates start an exchange sweep nobody
  // asked for.
  EXECUTION_FILL_RUNTIME_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // The CROSS-PROCESS ceiling on historical `/fapi/v1/userTrades` weight, per
  // accounting minute, shared by every worker sweeping the same account.
  //
  // Deliberately NOT the same value as EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT
  // above, which bounds ONE batch inside ONE process and multiplies by the
  // number of processes. This one is the ceiling those processes share.
  //
  // NO DEFAULT, on purpose. A default would let somebody enable the runtime
  // without ever deciding what share of the account's exchange allowance this
  // subsystem may take -- and that share cannot be derived from source, because
  // nothing here measures what the rest of Teddy already spends. It is optional
  // only while the runtime is off; the refinement below requires it the moment
  // EXECUTION_FILL_RUNTIME_ENABLED is true.
  //
  // A multiple of one dispatch (5): a ceiling of 27 would buy exactly the same
  // five requests as 25 while reading as though it bought more.
  EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE: wholeNumberString
    .pipe(z.number().int().min(5).multipleOf(5))
    .optional(),

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
  // A soft target above the hard cap could never be reached before the hard
  // cap rejected the admission first, so the soft gate would be dead code and
  // the configuration would silently mean something other than it says.
  if (value.EXECUTION_SOFT_OPEN_POSITION_TARGET > value.EXECUTION_MAX_OPEN_POSITIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXECUTION_SOFT_OPEN_POSITION_TARGET"],
      message: "EXECUTION_SOFT_OPEN_POSITION_TARGET must be <= EXECUTION_MAX_OPEN_POSITIONS",
    });
  }

  // A weak operator token is worse than none: it protects the one API that can
  // arm a real-money account. Length is checked at startup rather than per
  // request so a mistake fails loudly at boot, not silently under load.
  if (value.OPERATOR_API_TOKEN && value.OPERATOR_API_TOKEN.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPERATOR_API_TOKEN"],
      message: "OPERATOR_API_TOKEN must be at least 32 characters when set",
    });
  }

  // The shared historical ceiling is required exactly when the historical
  // runtime may run, and irrelevant otherwise -- the same shape the read-only
  // connector already uses for its credentials below. Fails at STARTUP rather
  // than at the first batch: a worker that discovered mid-sweep that it had no
  // shared ceiling would already have spent weight nobody budgeted.
  if (
    value.EXECUTION_FILL_RUNTIME_ENABLED &&
    value.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE"],
      message:
        "EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE is required when " +
        "EXECUTION_FILL_RUNTIME_ENABLED=true",
    });
  }

  // Phase 11F -- credential presence is NOT a global configuration rule.
  //
  // This used to require BINANCE_API_KEY and BINANCE_API_SECRET whenever
  // BINANCE_READ_ONLY_ENABLED was true, which was right while every backend
  // process was account-bound. After the 11F split two processes are not:
  // the generic backend and the generic analysis worker hold no account and
  // build no exchange client, yet they parse this same schema -- so the rule
  // stopped them booting on a credential they have no use for, while the
  // safe posture (read-only enabled) is exactly what they should keep.
  //
  // Enforcement did not disappear; it belongs where the credential is
  // actually consumed. `resolveConfiguredExchangeCredentials` refuses with
  // EXCHANGE_CREDENTIALS_MISSING and `configuredExchangeClientOptions`
  // throws, so no signed client can be constructed without one. Both
  // account entrypoints reach that seam BEFORE they attest, listen as
  // account-ready, or orchestrate -- which is strictly earlier than the
  // first signed request this rule used to protect.
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
