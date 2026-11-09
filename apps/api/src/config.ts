import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_NAME: z.string().default('MaxCloud'),
  /** Public URL of the web app (used in emails, redirects, CSRF origin check). */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Extra allowed origins (comma separated), e.g. the desktop app's tauri://localhost */
  EXTRA_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32),
  /** 32 bytes hex — encrypts TOTP secrets */
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  COOKIE_SECURE: bool,

  // Storage (S3-compatible: B2 / R2 / Wasabi / local VersityGW)
  STORAGE_PROVIDER: z.enum(['b2', 'r2', 'wasabi', 'local']).default('b2'),
  S3_ENDPOINT: z.string().url(),
  /** Endpoint the *browser* uses for presigned URLs (differs from S3_ENDPOINT inside Docker). */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-005'),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: bool,
  /** 'AES256' requests SSE-B2/SSE-S3 per object. R2 and Wasabi always encrypt at rest; set 'none' for them. */
  S3_SSE: z.enum(['AES256', 'none']).default('AES256'),
  /** presigned: browser downloads straight from S3 endpoint. worker: via Cloudflare Worker at DOWNLOAD_BASE_URL (free B2 egress). */
  DOWNLOAD_MODE: z.enum(['presigned', 'worker']).default('presigned'),
  DOWNLOAD_BASE_URL: z.string().url().optional(),
  DOWNLOAD_SIGNING_SECRET: z.string().optional(),

  // OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),

  // Email
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('MaxCloud <no-reply@maxcloud.uz>'),

  // Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYME_MERCHANT_ID: z.string().optional(),
  /** Key Payme uses in Basic auth (login "Paycom"). Use the TEST key in dev. */
  PAYME_KEY: z.string().optional(),
  PAYME_CHECKOUT_URL: z.string().url().default('https://checkout.paycom.uz'),

  // Security / ops
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().default(3310),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_DISABLED: bool,
  /** COGS alert threshold for the admin economics view */
  COGS_ALERT_RATIO: z.coerce.number().default(0.6),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests that mutate process.env. */
export function resetConfig() {
  cached = null;
}

export function allowedOrigins(): string[] {
  const c = config();
  return [c.WEB_ORIGIN, ...c.EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
}
