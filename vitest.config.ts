import { defineConfig } from 'vitest/config';

// Tests never reach a model unless asked: by default the cloud keys are blank and OLLAMA_URL points
// at a closed port, so the suite runs the same on a laptop with Ollama and on CI without it
// (tests/helpers/fakeAi.ts stands in). REKINDLE_LIVE_TESTS=1 keeps the real settings from .env for the
// opt-in live checks (tests/ollama.test.ts, tests/deepseek_live.test.ts, tests/full_e2e.test.ts).
const live = process.env.REKINDLE_LIVE_TESTS === '1';

// Tests never touch the development database: the default points at a closed port, so a test that
// forgets to stub a Testcontainers URL fails instead of writing to the owner's data.
const isolatedDb = { DATABASE_URL: 'postgres://rekindle:rekindle@127.0.0.1:9/tests_must_use_testcontainers' };

export default defineConfig({
  test: {
    env: live ? isolatedDb : { ...isolatedDb, GEMINI_API_KEY: '', DEEPSEEK_API_KEY: '', OLLAMA_URL: 'http://127.0.0.1:9' },
  },
});
