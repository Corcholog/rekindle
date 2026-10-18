import { defineConfig } from 'vitest/config';

// Tests never reach a cloud LLM unless asked: LOOM_LIVE_TESTS=1 keeps the keys from .env, so the
// opt-in live checks (tests/deepseek_live.test.ts, tests/full_e2e.test.ts) can run.
const live = process.env.LOOM_LIVE_TESTS === '1';

// Tests never touch the development database: the default points at a closed port, so a test that
// forgets to stub a Testcontainers URL fails instead of writing to the owner's data.
const isolatedDb = { DATABASE_URL: 'postgres://loom:loom@127.0.0.1:9/tests_must_use_testcontainers' };

export default defineConfig({
  test: {
    env: live ? isolatedDb : { ...isolatedDb, GEMINI_API_KEY: '', DEEPSEEK_API_KEY: '' },
  },
});
