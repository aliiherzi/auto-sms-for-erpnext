/** Bootstrap configuration from environment variables (and an optional .env file). */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const bool = (fallback: boolean) =>
  z.preprocess((v) => {
    const value = emptyToUndefined(v);
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }, z.boolean());

const EnvSchema = z.object({
  ADMIN_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string({ error: 'ADMIN_PASSWORD is required (password for the dashboard)' }).min(8, 'ADMIN_PASSWORD must be at least 8 characters'),
  ),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  HOST: z.preprocess(emptyToUndefined, z.string().default('0.0.0.0')),
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('./data')),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')),
  ERPNEXT_URL: optionalString,
  ERPNEXT_API_KEY: optionalString,
  ERPNEXT_API_SECRET: optionalString,
  /** Shared secret for ERPNext webhooks (X-Frappe-Webhook-Signature). */
  WEBHOOK_SECRET: optionalString,
  /** Optional HTTP(S) proxy for the WhatsApp connection. */
  WHATSAPP_PROXY: optionalString,
  /** "baileys" (real WhatsApp) or "fake" (records messages, for testing). */
  WHATSAPP_DRIVER: z.preprocess(emptyToUndefined, z.enum(['baileys', 'fake']).default('baileys')),
  /** Set when running behind a reverse proxy (nginx, Traefik…) so secure cookies work. */
  TRUST_PROXY: bool(false),
  SESSION_SECRET: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

/** Loads .env (if present, without overriding real environment variables) and validates. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, envFile = '.env'): Env {
  if (source === process.env && fs.existsSync(envFile)) {
    for (const [key, value] of Object.entries(parseDotEnv(fs.readFileSync(envFile, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Configuration problem:\n${problems}\nCopy .env.example to .env and fill it in.`);
  }
  return { ...parsed.data, DATA_DIR: path.resolve(parsed.data.DATA_DIR) };
}

/** Minimal .env parser: KEY=value, optional quotes, # comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[match[1]] = value;
  }
  return out;
}
