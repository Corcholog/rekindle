import { defineConfig } from 'vitest/config';

// Tests never reach a cloud LLM unless asked: LOOM_LIVE_TESTS=1 keeps the keys from .env, so the
// opt-in live checks (tests/deepseek_live.test.ts, tests/full_e2e.test.ts) can run.
const live = process.env.LOOM_LIVE_TESTS === '1';

export default defineConfig({
  test: {
    env: live ? {} : { GEMINI_API_KEY: '', DEEPSEEK_API_KEY: '' },
  },
});
