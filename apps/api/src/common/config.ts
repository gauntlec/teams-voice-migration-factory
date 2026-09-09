import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().default(60 * 60 * 24 * 30),
  DATA_ENCRYPTION_KEY: z.string().min(1),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Empty => host-only cookie (correct when the app is reached by bare IP).
  COOKIE_DOMAIN: z.string().default(''),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TOTP_ISSUER: z.string().default('Voxshift'),
});

export type AppConfig = z.infer<typeof schema> & { REFRESH_COOKIE: string };

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  return { ...parsed.data, REFRESH_COOKIE: 'tvmf_rt' };
}
