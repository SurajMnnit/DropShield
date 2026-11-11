import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Attempt to load .env from workspace root first, then local directory
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z
    .string()
    .default('development'),
  PORT: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535)),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z
    .string()
    .default('5432')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535)),
  POSTGRES_DB: z.string().default('dropshield'),
  POSTGRES_USER: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default('postgres'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/dropshield'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z
    .string()
    .default('6379')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535)),
  REDIS_PASSWORD: z.string().optional().default(''),
  RABBITMQ_DEFAULT_USER: z.string().default('guest'),
  RABBITMQ_DEFAULT_PASS: z.string().default('guest'),
  RABBITMQ_HOST: z.string().default('localhost'),
  RABBITMQ_PORT: z
    .string()
    .default('5672')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535)),
  RABBITMQ_MANAGEMENT_PORT: z
    .string()
    .default('15672')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535)),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
  JWT_SECRET: z.string().default('dev_jwt_secret_dropshield_default_development_key_32chars'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  COOKIE_SECRET: z.string().default('dev_cookie_secret_dropshield_development_key_32chars'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Environment validation failed:');
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));
  process.exit(1);
}

export const env = parsedEnv.data;
export type AppEnv = z.infer<typeof envSchema>;
