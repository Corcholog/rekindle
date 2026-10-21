import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// The API has no authentication, so it must only listen on loopback.
const LOOPBACK_BIND_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// An empty value in .env means "not set"
const languageVar = z.preprocess(v => (v === '' ? undefined : v), z.enum(['es', 'en']).optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1').refine(
    (host) => LOOPBACK_BIND_HOSTS.includes(host),
    { message: 'HOST must be a loopback address (127.0.0.1, localhost or ::1): the API has no authentication' },
  ),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://rekindle:rekindlepassword@localhost:5432/rekindledb'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  EMBED_MODEL: z.string().default('bge-m3'),
  CHAT_MODEL: z.string().default('gemini-3.1-flash-lite'),
  GEMINI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  // Order in which LLM providers are tried: deepseek, gemini, ollama (those without a key are skipped)
  LLM_PROVIDERS: z.string().default('deepseek,gemini,ollama').refine(
    (list) => list.split(',').map(n => n.trim()).filter(Boolean).every(n => ['deepseek', 'gemini', 'ollama'].includes(n)),
    { message: 'LLM_PROVIDERS may only list deepseek, gemini and ollama' },
  ),
  VAULT_PATH: z.string().optional(),
  // Languages (src/ai/language.ts): LANGUAGE presets the other two; read at call time
  LANGUAGE: languageVar,
  OUTPUT_LANGUAGE: languageVar,
  NOTES_LANGUAGE: languageVar,
});

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return EnvSchema.parse(raw);
}

export const env = parseEnv(process.env);

export const PROJECT_DIR_NAMES = ['Projects', 'Proyectos'] as const;

export const VECTOR_DISTANCE_THRESHOLD = 0.6;
// Closest projects handed to the LLM per article. Chosen with evals/SWEEP.md: 3 keeps 86% of the
// relevant pairs at 45% fewer calls than 10.
export const TOP_K_PROJECTS_LIMIT = 3;
// Characters of note text per project in a prompt (about 15k tokens). A project that fits is sent
// whole; a larger one sends the notes closest to the article first (src/evaluator/notesContext.ts).
export const NOTES_CONTEXT_CHARS = 60_000;
// Characters of an article, transcript or clipped selection that Rekindle reads and summarizes
export const MAX_ARTICLE_CHARS = 50_000;
// Largest ingest request accepted; the extension cuts selections to MAX_ARTICLE_CHARS before sending
export const MAX_INGEST_BODY_BYTES = 256 * 1024;
// Consultor: the library items and notes closest to the question, each cut (titles, sources and
// note paths too), so the prompt stays under 63,000 characters (tests/consult_budget.test.ts)
// whatever the size of the library and the vault
export const CONSULT_TOP_CONTENTS = 15;
export const CONSULT_TOP_NOTES = 15;
export const CONSULT_SUMMARY_CHARS = 2_000;
export const CONSULT_NOTE_CHARS = 1_800;
export const CONSULT_LABEL_CHARS = 300;
export const MAX_CONSULT_QUERY_CHARS = 2_000;
export const STALE_DRIFT_THRESHOLD = 0.04;
export const PROMOTION_DELTA_THRESHOLD = 0.08;
export const NOTE_PROMOTION_DISTANCE_THRESHOLD = 0.50;

