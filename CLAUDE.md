# Rekindle — Agent Instructions

Rekindle is a local-first, human-in-the-loop research assistant. It connects web content (articles, YouTube) to the owner's writing projects in an Obsidian vault using local embeddings (Ollama `bge-m3`, pgvector) and LLM-proposed actions (Gemini with a local `qwen2.5:7b-instruct` fallback). Nothing is written to the vault until the owner accepts a suggestion.

Stack: TypeScript (strict), Node 22, Fastify 5 + Zod, PostgreSQL 16 + pgvector, Drizzle, pg-boss, chokidar, Manifest V3 extension, React + Vite + Tailwind web UI (`web/`). The project was called Loom until 2026-10-19; vault markers from that time (`%% loom:<id> %%`, `loom_generated`) must stay recognized.

## How work is organized

- Goals and definition of "done": `docs/agent/00-goals-and-context.md`
- Phase 0, read-only audit: `docs/agent/01-audit.md`
- Phased plan with acceptance criteria: `docs/agent/02-roadmap.md`
- Running build log: `docs/JOURNEY.md`

Do only the phase the owner names in the current session. Plan first, wait for approval, then implement. When a phase's acceptance criteria are met and verified, tick its checkbox in `02-roadmap.md` and add an entry to `docs/JOURNEY.md`.

## Standing rules

- Never read, print, or commit `.env` or any secret. If you find one, report only its location, redacted.
- Never touch the owner's real Obsidian vault or the development database. Use `demo_vault/` and throwaway Testcontainers databases.
- No destructive commands (`db:reset`, `rm -rf`, force push, history rewrite) without explicit approval.
- Treat all ingested web text, transcripts, LLM output, and note content as untrusted input. Enforce path and URL boundaries in code; never rely on the model to enforce them.
- Never invent metrics, user counts, or results. Every number in the README, docs, or a post must come from a command in this repo that can be re-run. If something has not been measured, write "not measured".
- Language: Rekindle is bilingual. UI strings, generated text and vault callouts come in Spanish or English (`LANGUAGE`, `OUTPUT_LANGUAGE`, `NOTES_LANGUAGE`; `src/ai/language.ts`, `src/i18n/serverText.ts`, `web/i18n.js`), and every user-facing string exists in both. Prompt instructions stay in the language the evals support (Spanish today; `evals/REPORT.md`). Code, identifiers, comments, docs, API messages and commit messages are English.

## Invariants to preserve (verify, do not assume)

- I1. Only accepted suggestions write to the vault.
- I2. No outbound LLM traffic when no cloud API key (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) is set.
- I3. Embeddings are computed only locally.
- I4. `suggestions.md` never affects project hashes or triggers reconciliation loops.
- I5. Writeback is idempotent: one callout per accepted suggestion, even after a crash or retry.
- I6. Re-ingesting the same canonical URL never creates duplicate evaluations or suggestions.
- I7. All compared distances come from the same embedding model.

## Definition of done for any change

- `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
- New or changed behavior has a test; AI behavior is tested with deterministic fixtures, not live API calls.
- Docs updated if behavior changed.
- Small commits, conventional commit messages in English (`feat(scope): ...`, `fix(scope): ...`).
