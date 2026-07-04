import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().min(1).default("http://localhost:5173"),
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
  BINANCE_REST_BASE_URL: z.string().min(1).default("https://api.binance.com"),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
