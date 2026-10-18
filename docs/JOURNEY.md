# Loom — Journey Log

A factual record of what was decided, tried, broken, and fixed while taking Loom from a working prototype to a publishable version. It is the source material for the README story and the LinkedIn post.

**How to use it:** after each phase (and after any notable discovery), add an entry. Facts only: what happened, what evidence supports it (commit, test, file, report), and what was learned. No invented metrics; unmeasured things say "not measured". Include failures and dead ends.

## Starting point

- Code state at the start of this effort: git `master` @ `1cc4432` plus working-tree refinements.
- Verification at the start: `tsc --noEmit` clean, `eslint .` clean, 9 offline unit tests passing. Integration and e2e tests require Docker/Testcontainers.
- Known gaps at the start: no evaluation dataset or metrics, minimal telemetry (model, latency, success), no CI, setup requires Docker + Ollama + Postgres knowledge.

## Phase log

<!-- Copy this block for each entry -->
### YYYY-MM-DD — Phase N: short title
- **Context:** what we were trying to do and why.
- **What happened:** the decision, change, or discovery.
- **Alternatives considered:** what else was an option and why it was not chosen.
- **Evidence:** commit hashes, test names, report paths.
- **Outcome / lesson:** what changed and what was learned.

### 2026-10-17 — Phase 1: Cleanup of dead code and legacy
- **Context:** The Phase 0 audit (`docs/audit/AUDIT_REPORT.md`, kept local) listed unused files, superseded routes, stale scripts and tests, unused columns and docs that contradicted the code. Cleaning up first makes the later security fixes and the eval harness cheaper.
- **What happened:**
  - Uncommitted work was committed as a baseline and tagged `pre-cleanup`.
  - Removals followed the approved list, one group per commit: the bookmarklet (the extension is now the only clipper), superseded routes, unused modules and exports, unused dependencies and `spikes/`, stale scripts, the scaffolding test, and five unused columns (migration `0003`).
  - The architecture doc, README and ADRs were rewritten to match the code, and the remaining gaps are documented as known issues.
- **Alternatives considered:**
  - Keeping `/api/library/ask` and `/api/library/search` as API-only features: rejected, because no client called them and the Consultor replaced them.
  - Moving the old phase reports to `docs/history/`: the owner chose deletion, since git history keeps them.
  - Populating `contents.source_type`: rejected, because it would be a new feature during a cleanup phase.
- **Evidence:** commits `cdc2d5e`…`7a66067` after tag `pre-cleanup`; `pnpm test:coverage` runs in the metrics table below.
- **Outcome / lesson:**
  - Line coverage of `src/` went up because untested dead code left. ESLint went from 6 warnings to 0.
  - With a live Ollama (`bge-m3` + `qwen2.5:7b-instruct`), every test passes except the Gemini-only e2e test, which skips.
  - Without Ollama, the 8 remaining failures are all tests that call a live model. A fake provider is still missing (Phase 5).
  - Removing the bookmarklet also removed `Access-Control-Allow-Origin: *` and the `?quick_ingest=` auto-submit, which closes one cross-site ingestion path (audit F-02). The rest of F-02 (Host/Origin validation) is Phase 2.

### 2026-10-17 — Phase 2: Fix Critical and High findings
- **Context:** The audit found one Critical and four High findings (a local API any web page could reach, cross-site ingestion, unsanitized model text in the vault, automatic vault writers, a hostname-only SSRF check), plus integrity bugs against invariants I5–I7. Phase 2 had to close them before anything is published.
- **What happened:**
  - Each fix landed in its own commit with a regression test that failed before the fix.
  - Owner decisions shaped three fixes:
    - I6 is literal: re-ingesting never re-evaluates.
    - Synergy notes and briefs are written only by an explicit "Guardar en Obsidian" button.
    - I7 is enforced now, with existing vectors backfilled as `bge-m3`.
  - Three Low/Medium fixes were included because they touched the same code: `.env` writer, generic 500 messages, Postgres bound to localhost.
- **Alternatives considered:**
  - A per-install API token: rejected for now. Loopback-only binding plus Host/Origin checks blocks the web-page attacks, and a token would add setup friction for a solo local app.
  - Resolving DNS once before fetching: rejected, because the IP could change before the connection (DNS rebinding). The check runs inside the connect-time lookup instead.
  - Keeping the claim-then-append writeback: rejected because of the crash window. Callouts now carry markers, and the write runs under a row lock.
- **Evidence:** commits `0bde5b8`…`c1d543a`. Tests listed in the table below. Migrations `0004` (unique `evaluation_id`) and `0005` (`embedding_model` on snapshots).
- **Outcome / lesson:**
  - Every test passes with a live Ollama (123 passed, 1 skipped), and line coverage of `src/` is 84.06%.
  - Two timing-dependent tests passed even before their fix: concurrent accepts did not interleave under `server.inject`. Only deterministic tests (a database constraint, a simulated crash) proved those fixes. Race tests that rely on timing alone prove little.
  - Two test fixtures attached two suggestions to one evaluation, which the real evaluator never does. The new uniqueness constraint exposed them.
  - On the Gemini e2e run after Phase 2, Gemini answered HTTP 503 ("model is currently experiencing high demand") twice. Loom fell back to local Ollama and the test still passed, so the provider fallback was exercised live.
  - I committed one test that did not typecheck (`16e5b63` fixed it). Since then, typecheck and lint run before every commit.

### 2026-10-18 — Phase 3: evaluation harness and a DeepSeek provider chain
- **Context:** Until now nothing showed whether Loom picked the right projects or whether a model change helped. The owner also wanted DeepSeek (`deepseek-flash`, about $2 of credit) as the first LLM, with Gemini (free tier) and local Qwen as fallbacks.
- **What happened:**
  - Built the provider chain (`LLM_PROVIDERS`, DeepSeek with thinking explicitly off, one retry on malformed output, per-attempt records) and a harness (`pnpm eval`) that runs the real reconciler, retrieval and evaluator on a throwaway Postgres.
  - Dataset: 47 articles (29 real, from the owner's URLs; 18 synthetic) against 8 projects (2 real with 5 notes in total, 6 synthetic distractors from areas the owner named), 376 labeled pairs.
  - Compared Gemini, DeepSeek and Qwen alone, each on identical summaries and retrieval, then flipped the default chain to DeepSeek → Gemini → Ollama in a separate commit.
  - The owner approved a read-only copy of the two real projects into the git-ignored `evals/private/`. This is the one exception to "never touch the real vault"; the vault itself was only read.
- **Alternatives considered:**
  - Switching to DeepSeek first and measuring afterwards: rejected, to get a real before/after.
  - Evaluating the production chain (with fallbacks) instead of single providers: rejected for quality comparison, because a fallback silently replaces one model's answers with another's; chains are covered by unit tests instead.
  - Letting the agent propose labels: rejected; every verdict is the owner's.
- **Evidence:** commits `25a5df4`…`56fd36e`; `evals/REPORT.md`; first-pass and recomputed result files in `evals/results/`.
- **Outcome / lesson:**
  - **Label quality changed the ranking.** The owner labeled quickly the first time (18 actionable / 8 tentative / 350 irrelevant). With those labels Qwen came first (macro-F1 0.61, DeepSeek 0.53, Gemini 0.43). After the owner re-checked every label with the review page (31 / 20 / 325) DeepSeek came first (0.74, Gemini 0.56, Qwen 0.61). A model comparison is only as good as its labels.
  - Qwen is extremely conservative (100% precision, 39% recall on `actionable`); Gemini finds everything but over-calls (44% precision); DeepSeek balances both (94% / 97%).
  - The default switch followed the pre-agreed rule (at least as good on triage and target-note accuracy, at lower cost or latency): macro-F1 0.74 vs 0.56, target note 42% vs 37%, p50 latency 2.1 s vs 4.2 s, no overloads.
  - The 0.6 retrieval threshold lets 94% of unrelated articles through, so every article costs several LLM calls; a threshold sweep is the biggest open lever.
  - Weak spots for all models: `tentative` (F1 0.18–0.38 on 20 pairs) and target-note choice (32–42% on 19 pairs). Not done yet: thinking-on for the action step (needs splitting triage and action into two calls), and suggestion-quality ratings (not measured).
  - Process lessons: a Gemini 503 ("high demand") would have been scored as a wrong "irrelevant", so 5xx errors are retried in evals; the first Gemini run let Qwen answer one call through the fallback, which led to single-provider eval configs; I once committed with two failing tests because my command chain used `;` instead of `&&`; with DeepSeek first in the default chain, tests would have used the real key, so tests now run with cloud keys blanked unless `LOOM_LIVE_TESTS=1`.

## Bugs and vulnerabilities found

| ID | What was wrong | How it was found | Severity | Fixed in | Test that proves the fix |
|---|---|---|---|---|---|
| F-01 | No Host/Origin validation: a web page could reach the local API through DNS rebinding (read notes, accept suggestions) | Phase 0 audit, code reading | Critical | `0bde5b8` | `tests/request_guard.test.ts` |
| F-02 | `Access-Control-Allow-Origin: *` on ingest and an auto-submitting `?quick_ingest=` let any website push content into the pipeline | Phase 0 audit | High | `7be41b1` (bookmarklet removal), `0bde5b8` (Origin guard) | `tests/phase7_ui.test.ts` (Feature 2), `tests/request_guard.test.ts` |
| F-03 | Synergy notes and research briefs written to the vault without the accept flow; the brief overwrote manual edits and fed back into project context | Phase 0 audit | High | `d59f564` | `tests/generated_notes.test.ts`, `tests/phase7_ui.test.ts` (Features 4–5) |
| F-04 | Model text written to the vault raw (code fences, embeds, HTML, forged callouts) | Phase 0 audit | High | `f6e1004` | `tests/vault_sanitize.test.ts` |
| F-05 | SSRF guard was a hostname string check: redirects, DNS, IPv6 and IPv4-mapped addresses bypassed it; body read fully before the size cap | Phase 0 audit | High | `f510026` | `tests/safe_fetch.test.ts` |
| F-06 | Writeback crash window: flag set before the append, so a crash lost the callout permanently | Phase 0 audit | Medium | `6c9b933` | `tests/writeback_recovery.test.ts` |
| F-07 | Concurrent accept of a tentative item could create two suggestions and two callouts | Phase 0 audit | Medium | `a94fca7` | `tests/tentative_accept_race.test.ts` |
| F-08 | Re-ingesting a URL bumped `consumption_seq` and re-ran evaluation, duplicating suggestions (invariant I6) | Phase 0 audit; owner decided I6 is literal | Medium | `89fd28b` | `tests/reingest_idempotency.test.ts` |
| F-10 | Vault-path `.env` writer allowed newline injection and `$`-pattern corruption; non-atomic write | Phase 0 audit | Low | `33a2c1b` | `tests/env_writer.test.ts` |
| F-17 | Embedding model not tracked on snapshots or enforced in distance queries (invariant I7) | Phase 0 audit | Medium | `cbaf4a2` | `tests/embedding_model.test.ts` |
| F-22 | Docker Postgres published on all interfaces with the default password | Phase 0 audit | Medium | `c1d543a` | not testable in the suite (config); verified with `docker compose config` |
| F-26 | 500 responses returned internal error text (provider errors, hosts) | Phase 0 audit | Low | `38f49dd` | `tests/error_responses.test.ts` |

## Dead code and legacy removed

| Item | Why it was there | Why it was removed | Commit |
|---|---|---|---|
| Bookmarklet, `?quick_ingest=` auto-submit, `Access-Control-Allow-Origin: *` on `/api/ingest` | Clipper that ran inside third-party pages | Owner chose the extension as the only clipper; the wildcard CORS and auto-submit let any website trigger ingestion | `7be41b1` |
| `/api/library/search`, `/api/library/ask` | Earlier "Ask My Library" RAG feature | Superseded by the Consultor (`/api/library/consult`); no client called them | `07f0890` |
| `GET /api/projects/:id`, `GET /ping` | Project detail endpoint; extra liveness probe | Not called by the UI or extension; `/health` remains | `07f0890` |
| `src/db/repositories.ts`, `src/vault/index.ts`, unused exports | Early data-access layer and barrel file | No importers (knip) | `2c7d757` |
| `spikes/`, `ollama`, `@huggingface/transformers`, `pgvector`, `testcontainers` v10, `ts-node`, monorepo workspace globs | Phase 0 go/no-go experiments and early scaffolding | Unused at runtime and in tests | `7c1eb33` |
| `src/db/seed.ts`, `scripts/seed_demo.ts`, `scripts/reconcile_and_reevaluate.ts`, `scripts/generate_extension_icons.ts` | Early demo data, a destructive maintenance script, and the icon generator | Stale (fake hash, mismatched demo note) or one-off; icons are committed | `676072b` |
| `tests/dummy.test.ts`, stale UI assertions (a personal Windows path, a removed form id) | Scaffolding and older UI | Tested nothing current | `c8b07e6`, `7be41b1`, `07f0890` |
| Columns `contents.source_type`, `contents.is_raw_purged`, `action_suggestions.custom_type_label`, `target_section`, `source_reference` | Planned features never built | Never written by the app (data loss: demo-seed values only); dropped in migration `0003` | `5bc3345` |
| `docs/fase-0…7-report.md`, `docs/code-review.md`, `AGENTS.md` | Historical phase reports, pre-audit review, instructions for another agent tool | Contradicted the current code; owner chose deletion (kept in git history) | `7a66067` |

## Metrics, before and after

| Date | Change | Metric | Before | After | Command / report |
|---|---|---|---|---|---|
| 2026-10-17 | Phase 1 cleanup | Line coverage of `src/`, no Ollama/Gemini | 72.68% (4027/5540) | 74.75% (3785/5063) | `pnpm test:coverage --exclude tests/ollama.test.ts` with `GEMINI_API_KEY=` and an unreachable `OLLAMA_URL`; `pre-cleanup` vs `7a66067` |
| 2026-10-17 | Phase 1 cleanup | Branch / function coverage, no Ollama/Gemini | 59.44% / 70.73% | 59.68% / 74.35% | same |
| 2026-10-17 | Phase 1 cleanup | Tests, no Ollama/Gemini (passed / failed / skipped) | 58 / 12 / 1 | 56 / 8 / 1 | same. Removed tests account for the lower pass count; every remaining failure needs a live model. |
| 2026-10-17 | Phase 1 cleanup | Tests with live Ollama, no Gemini (passed / failed / skipped) | not measured | 66 / 0 / 1 | `pnpm test:coverage` with Ollama `bge-m3` + `qwen2.5:7b-instruct` and `GEMINI_API_KEY=` |
| 2026-10-17 | Phase 1 cleanup | ESLint warnings | 6 | 0 | `pnpm lint` |
| 2026-10-17 | Phase 1 cleanup | `tests/full_e2e.test.ts` with Gemini (synthetic vault and article) | not measured | 1 / 0 / 0 (served by `gemini:gemini-3.1-flash-lite`) | `pnpm vitest run tests/full_e2e.test.ts` with `GEMINI_API_KEY` from `.env` |
| 2026-10-17 | Phase 2 fixes | Line / branch / function coverage of `src/`, live Ollama, no Gemini | not measured (Phase 1 coverage was only measured offline) | 84.06% / 67.31% / 81.57% | `pnpm test:coverage` with `GEMINI_API_KEY=` |
| 2026-10-17 | Phase 2 fixes | Line / branch / function coverage of `src/`, no Ollama/Gemini | 74.75% / 59.68% / 74.35% | 84.20% / 67.79% / 81.57% | `pnpm test:coverage --exclude tests/ollama.test.ts`, unreachable `OLLAMA_URL` |
| 2026-10-17 | Phase 2 fixes | Tests with live Ollama, no Gemini (passed / failed / skipped) | 66 / 0 / 1 | 123 / 0 / 1 | `pnpm test:coverage` with `GEMINI_API_KEY=` |
| 2026-10-17 | Phase 2 fixes | Tests without Ollama/Gemini (passed / failed / skipped) | 56 / 8 / 1 | 114 / 7 / 1 | offline command above; every failure needs a live model |
| 2026-10-18 | Label review (owner re-checked all 376 pairs) | Triage macro-F1, DeepSeek Flash | 0.53 | 0.74 | `pnpm eval run evals/private --config evals/configs/deepseek-flash.json --replay` |
| 2026-10-18 | Label review | Triage macro-F1, Gemini 3.1 Flash Lite | 0.43 | 0.56 | `…baseline-gemini.json --replay` |
| 2026-10-18 | Label review | Triage macro-F1, Qwen 2.5 7B | 0.61 | 0.61 | `…qwen-local.json --replay` |
| 2026-10-18 | Default chain Gemini → DeepSeek first | Triage macro-F1 / target-note accuracy / p50 latency (same labels) | 0.56 / 37% / 4.2 s (Gemini) | 0.74 / 42% / 2.1 s (DeepSeek) | same commands; `evals/REPORT.md` |
| 2026-10-18 | Retrieval, threshold 0.6, k=3 | Recall / precision / false retrieval | not measured | 91% / 55% / 94% | `pnpm eval run … --replay` |
| 2026-10-18 | DeepSeek spend | Estimated list-price cost, 215 triage calls | not measured | about $0.18 (summaries about $0.06 more) | token counts in the result files; not a billed amount |
| 2026-10-18 | Phase 3 tests | Tests passed / skipped, hermetic (live Ollama, no cloud keys) | 123 / 1 | 186 / 2 | `pnpm test:coverage`; lines 84.06% → 85.28% |
| 2026-10-17 | Phase 2 fixes | `tests/full_e2e.test.ts` with the Gemini key set | 1 / 0 / 0 | 1 / 0 / 0, served by Ollama after two Gemini HTTP 503 responses | `pnpm vitest run tests/full_e2e.test.ts` |

## Dead ends and things that did not work

- **ONNX embeddings in Node (`@huggingface/transformers`, `paraphrase-multilingual-MiniLM-L12-v2`):** the Phase 0 spike recorded ≈665 MB RSS against a 500 MB budget, a NO-GO (ADR 002; this number was not re-measured). Loom moved to Ollama `bge-m3`. The spike code was removed in `7c1eb33`.
- **"Ask My Library" (top-5 RAG with `[1]`, `[2]` citations):** replaced by the full-catalog Consultor, then removed in `07f0890`. Open question for Phase 3: the Consultor sends the whole catalog in one prompt, which will not scale.
- **Recording an eval fixture with a throwaway script:** the first attempt (a top-level-await `.ts` file) failed on the CJS output format and went against the owner's rule that checks live in the project; the CLI's `--record` flag replaced it.
- **Evaluating the production chain as one unit:** fallbacks hid which model had answered; evals use one provider per config.
- **Bookmarklet clipper:** convenient, but it required an open CORS policy on `/api/ingest`. Removed in favor of the extension (`7be41b1`).
