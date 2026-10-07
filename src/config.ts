import 'dotenv/config';
import { z } from 'zod';

/**
 * An empty value in a .env file means "not set", not "set to the empty string".
 * Without this, a template left with `DATABASE_URL=` fails schema parsing and
 * crashes the process at boot instead of taking the documented
 * not-configured path.
 */
const optionalUrl = z.preprocess((value) => (value === '' || value === undefined ? undefined : value), z.string().url().optional());
const optionalString = z.preprocess((value) => (value === '' || value === undefined ? undefined : value), z.string().min(1).optional());

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: optionalUrl,
  SESSION_SECRET: optionalString.pipe(z.string().min(32).optional()),
  WEB_ORIGIN: z.string().url().default(process.env.NODE_ENV === 'production' ? 'https://verispon.com' : 'http://localhost:3000'),
  AUTO_RELEASE_HOURS: z.preprocess(
    (value) => value === '' || value === undefined ? undefined : value,
    z.coerce.number().positive().max(720).optional(),
  ),
  ENABLE_WORKERS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  RESEND_API_KEY: optionalString,
  RESEND_FROM_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.string().email().optional()),
  META_WHATSAPP_TOKEN: optionalString,
  META_WHATSAPP_PHONE_NUMBER_ID: optionalString,
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  META_APP_SECRET: optionalString,
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
  API_ORIGIN: optionalUrl,
  SESSION_SAME_SITE: z.preprocess((value) => value === '' ? undefined : value, z.enum(['lax', 'none']).optional()),
  NOMBA_API_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().default('https://api.nomba.com')),
  NOMBA_ACCOUNT_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().uuid().optional()),
  NOMBA_CLIENT_ID: optionalString,
  NOMBA_CLIENT_SECRET: optionalString,
  NOMBA_WEBHOOK_SECRET: optionalString,
});

export const config = configSchema.parse(process.env);
export const APPLICATION_SECRET = config.SESSION_SECRET ?? 'local-development-session-secret-change-this-value';

if (config.NODE_ENV === 'production' && !config.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production');
}

function registrableDomain(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    const labels = host.split('.');
    return labels.length <= 2 ? host : labels.slice(-2).join('.');
  } catch {
    return null;
  }
}

const webDomain = registrableDomain(config.WEB_ORIGIN);
const apiDomain = registrableDomain(config.API_ORIGIN ?? config.WEB_ORIGIN);

/**
 * Defaults to `none` only when the API is served from a different registrable
 * domain than the web origin, and `lax` otherwise. An explicit
 * SESSION_SAME_SITE always wins, so an operator can override the inference.
 */
function resolveSameSite(): 'lax' | 'none' {
  if (config.SESSION_SAME_SITE) return config.SESSION_SAME_SITE;
  return webDomain !== null && apiDomain !== null && webDomain !== apiDomain ? 'none' : 'lax';
}

export const SESSION_SAME_SITE = resolveSameSite();