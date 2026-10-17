import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://loom:loompassword@localhost:5432/loomdb'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  EMBED_MODEL: z.string().default('bge-m3'),
  CHAT_MODEL: z.string().default('gemini-3.1-flash-lite'),
  GEMINI_API_KEY: z.string().optional(),
  VAULT_PATH: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

export const PROJECT_DIR_NAMES = ['Projects', 'Proyectos'] as const;

export const VECTOR_DISTANCE_THRESHOLD = 0.6;
export const TOP_K_PROJECTS_LIMIT = 10;
export const STALE_DRIFT_THRESHOLD = 0.04;
export const PROMOTION_DELTA_THRESHOLD = 0.08;
export const NOTE_PROMOTION_DISTANCE_THRESHOLD = 0.50;

