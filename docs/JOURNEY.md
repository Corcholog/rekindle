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

### 2026-10-18 — Phase 3 follow-up: how many projects should reach the LLM?
- **Context:** At the 0.6 distance threshold 94% of unrelated articles still retrieved a project, and every article cost 4.6 LLM calls.
- **What happened:** Added `pnpm eval:sweep`, a retrieval-only analysis over the candidates stored with each run (no model calls), then verified the most promising cutoff exactly by replaying the three configs with `maxProjects: 3` from the cache (the prompts for the kept pairs are unchanged).
- **Evidence:** `evals/SWEEP.md`; result files `*-top3-private.json`; commits after `1e67810`.
- **Outcome / lesson:**
  - Distance separates relevant from irrelevant pairs only moderately: AUC 0.89, median 0.48 for relevant vs 0.56 for irrelevant pairs. A hard distance cutoff loses relevant pairs quickly (< 0.55 keeps 78% of them at 2.4 calls per article, < 0.50 keeps 57%).
  - Sending only the 3 closest projects keeps 86% of relevant pairs at 2.5 calls per article (−45%). Measured by replay: DeepSeek macro-F1 0.74 → 0.79, `actionable` recall 97% → 87% (3 of 31 pairs lost), cost of the triage calls about $0.18 → $0.11; Gemini 0.56 → 0.61; Qwen unchanged at 0.61; target-note accuracy unchanged. With 51 relevant pairs the F1 gain is within noise; the cost reduction is not.
  - The "false retrieval" rate stays at 94% with any rank cutoff, because a rank cutoff always returns something. The retrieval step cannot tell "nothing relevant" from distance alone; the LLM does that. The cutoff's job is cost, not precision.
  - Applied: `TOP_K_PROJECTS_LIMIT` went from 10 to 3 at the owner's request (`tests/top_projects_limit.test.ts`). The owner wants a deeper analysis later of what the LLM should and should not surface (see the open question below).

- **Open question from the owner (for the deeper analysis):** «Que vea cosas donde el usuario no, es importante, pero tampoco debe forzar conexiones (el tentativo muchas veces fuerza conexiones, aunque a veces hay irrelevantes para LLM que uno puede buscar conexión)». In English: the model should notice connections the user would miss, but must not force them. `tentative` often forces a link, yet some pairs the model calls irrelevant are ones a person could still find a connection in. What this means for the `tentative` label, for the prompt, and for what a rank cutoff throws away (the pairs ranked 4th or lower) has not been analyzed yet.

### 2026-10-18 — Phase 4: AI observability
- **Context:** Telemetry only recorded successful triage calls (model and latency). Retries, fallbacks, failures, tokens and cost were dropped, five of the six LLM features recorded nothing, and nothing linked a suggestion to the retrieval step that produced it. About 60 `console` calls printed article URLs, project titles, note paths and full error objects; an error message can quote model output.
- **What happened:**
  - Migration `0006` adds `pipeline_events` (one row per stage of a trace) and per-attempt columns on `llm_telemetry` (provider, attempt, error kind, fallback, wait, lengths, prompt hash). Evaluations store their trace and the retrieval event that selected them.
  - A trace ID starts at each ingestion and travels in the job payloads. Stages recorded: fetch, extract, summarize, embed, ingest job, retrieve (threshold, limit, the projects within the threshold before the limit, each candidate's rank and distance), one evaluate event per candidate, and the evaluation job.
  - `AiProvider.evaluateContent` takes a call context and writes one row per provider attempt, failures included, for all six LLM features. Cost uses a shared price table (`src/ai/pricing.ts`): DeepSeek at its peak list price (an upper bound), Ollama $0, Gemini "not priced" because a free and a paid key look the same.
  - Every `console` call in `src/` (except the migrate/reset CLIs) goes through one redacting pino logger, also used by Fastify with per-request logs off.
  - New commands: `pnpm telemetry:report`, `pnpm telemetry:trace`, `pnpm telemetry:prune` (needs an explicit age; nothing prunes automatically). Eval results now include the run's own telemetry, and run details include each article's trace ID.
- **Owner decisions:** one row per attempt (not per call), replace all `console` logging, CLI only (no UI page), manual prune.
- **Alternatives considered:** one telemetry row per call with attempts in jsonb (fallback and malformed rates would need jsonb queries); an `Observabilidad` UI page (more surface for the same numbers); automatic pruning at boot (deletes data without the owner asking).
- **Evidence:** commits `2dffd5e`…`a43f72d`; `tests/pipeline_trace.test.ts` (acceptance), `tests/telemetry_report.test.ts`, `tests/llm_telemetry.test.ts`, `tests/logger_redaction.test.ts`.
- **Outcome / lesson:**
  - The roadmap's three acceptance criteria are covered by tests: `telemetry:trace` leads from a suggestion to its content and retrieval event; the report shows latency, fallback rate, failure rate and cost over a period; and a sentinel planted in notes, articles, summaries, model output, error messages and URLs never reaches the logs or the telemetry tables, at debug level, including failure paths. A mutation check confirmed the test fails if a URL is logged.
  - Production numbers on the owner's real use are **not measured** yet: they need some days of normal use followed by `pnpm telemetry:report`.
  - **Incident:** while writing the telemetry test I ran it once on its own before it was correct. It imported a module that reaches `src/db` before stubbing the Testcontainers URL, so it used the development database from `.env`. It applied migration `0006` there (the same additive migration the owner would apply) and inserted 3 fake `llm_telemetry` rows, which the owner deleted. Fix: the test imports the module only after the stub, and `vitest.config.ts` now sets the default `DATABASE_URL` to a closed port, so a test making that mistake fails instead of writing anywhere. The full suite caught the next attempt.
  - node-postgres sends a JS `Date` in raw SQL as local time, while `timestamp` columns hold UTC (drizzle and `now()`). On this UTC−3 machine the report's time window would have been shifted by three hours. Caught while writing the report; time filters are sent as UTC ISO strings. No other raw SQL in `src/` passes a `Date`.
  - Partly closes audit F-09: evaluator LLM failures are now recorded, though still not retried. Closes F-27 (`console` logging without correlation).

### 2026-10-18 — Phase 5: CI, failure-scenario tests and a threat model
- **Context:** Four test files needed a live Ollama, so CI would have been red without one. The eight failure scenarios from the audit had no tests. Prompt injection (F-12), unvalidated target notes (F-13) and swallowed evaluation failures (F-09) were open, and there was no GitHub remote.
- **What happened:**
  - `tests/helpers/fakeAi.ts` stands in for the models through `AiProvider.setOverrides()`: a hashed bag-of-words embedder (deterministic; texts that share words are close) and a scripted LLM. Under Vitest `OLLAMA_URL` points at a closed port like `DATABASE_URL`, so the suite runs the same on a laptop with Ollama and on CI without it; live Ollama checks moved behind `LOOM_LIVE_TESTS=1`.
  - The owner created a **private** GitHub repo (public after Phase 7) and renamed `master` to `main`. CI runs typecheck, lint, the full suite (Testcontainers on the runner's Docker) and `pnpm audit --prod` on every push, with Actions pinned to commit SHAs; it passed on GitHub. `@fastify/static` 8 → 10 cleared the production advisories.
  - Each audit failure scenario has a test (mapping in `docs/THREAT_MODEL.md`). Writing them found and fixed: F-09 (a failed project evaluation now fails the job, so pg-boss retries it with backoff), F-12 (untrusted text delimited and tag-neutralized in all 14 prompt blocks, plus a data-not-instructions rule on every system prompt), F-13 (target notes must exist in the project; `LIKE` wildcards escaped), and the two bugs in the table below.
  - A review of the 28 `innerHTML` sinks in the web UI found them escaped; `tests/ui_xss.test.ts` now proves it by running the real page against the real API with hostile data.
  - `docs/THREAT_MODEL.md`: assets, untrusted inputs, 16 threats each with its mitigation, code and test, and residual risks.
- **Owner decisions:** add the GitHub remote now (private until Phase 7), keep the Gmail author address (no history rewrite), rename the branch to `main`, leave the anime fixture note as is, and show permanent evaluation failures in telemetry only (no UI change).
- **Alternatives considered:** a pgvector service container in CI instead of Testcontainers (the tests already start their own databases, and the runner has Docker); changing the queue policy so `singletonKey` de-duplicates (a queue's policy cannot be changed in place, and the owner's database already has the queues; idempotent handlers already make duplicates harmless); a UI marker for failed evaluations (owner chose telemetry only).
- **Evidence:** commits `50b52ea`…`072b7fc`; CI runs on GitHub; `tests/failure_*.test.ts`, `tests/ui_xss.test.ts`, `docs/THREAT_MODEL.md`.
- **Outcome / lesson:**
  - **Writing failure tests found real bugs.** An interrupted job could leave an actionable evaluation without its suggestion, and every retry then skipped the pair, so the suggestion was lost for good; the two rows are now written in one transaction. The `singletonKey` options on every job send never de-duplicated anything on pg-boss standard-policy queues (checked against a real instance) and were removed.
  - Each fix was checked by mutation: the interrupted-write test fails on the old evaluator, the `LIKE` test fails without escaping, and the UI test fails if one field loses its escaping.
  - **The prompt change has an eval cost.** Recorded answers are keyed by the exact prompt, so the private Phase 3 recordings no longer replay at the current commit, and the published eval numbers describe the earlier prompts. Before changing the prompts, a free replay measured the target-note validation alone: Gemini's target-note accuracy went from 7/19 to 9/19 (invented paths now fall back to the retrieved note); DeepSeek, Qwen and every verdict metric were unchanged. Re-measuring with the new prompts needs a paid DeepSeek run and has not been done.
  - Production advisories went from 4 (1 high, 3 moderate, all in `@fastify/static`) to 0 (`pnpm audit --prod`).

### 2026-10-18 — Phase 5 follow-up: re-measuring with the new prompts
- **Context:** Phase 5 changed every prompt, so the published eval numbers described the old ones. The owner asked to reword the appended data-not-instructions rule (it named two specific tags, which read oddly in prompts that use other tags) and to re-run the eval.
- **What happened:** the rule now speaks of text between tags in general (`ce14538`). The three top-3 configs were re-recorded live on the private set, reusing the cached DeepSeek summaries so retrieval stayed identical and only the triage prompts differed.
- **Evidence:** result files `*ce14538*` in `evals/results/`; `evals/REPORT.md` regenerated.
- **Outcome / lesson:**
  - DeepSeek Flash: macro-F1 0.79 → 0.78, `actionable` recall 27/31 → 26/31, target note 8/19 unchanged, about $0.12 at list price. Gemini Flash Lite: 0.61 → 0.67 (`tentative` F1 0.23 → 0.36). Qwen: 0.61 → 0.63. No failed or malformed calls. The models' run-to-run variance is not measured, so these differences may be noise; the safe reading is that the injection defenses did not hurt triage quality.
  - DeepSeek spend so far, at list price: about $0.36 of the $2 credit (estimate from token counts, not a billed amount).
  - The run's output exposed a logging bug: a log field named `level` (note- or project-level match) repeated pino's own `level` key, so those lines parsed with the level `note`. Log fields that collide with pino's keys are now renamed, and the eval CLI only shows warnings from the pipeline.

### 2026-10-19 — Phase 6: reproducibility, demo and user-test workflow (code and docs done; recording and testers pending)
- **Context:** someone else should be able to run Loom and judge it. The demo vault was one project with one 152-byte note, `start.sh` kept going after a failed migration, and the README had never been followed from a clean clone.
- **What happened:**
  - Replaced the demo vault with four synthetic Spanish projects (a lighthouse novel, an essay on attention, a board game, a podcast on urban history; 15 notes, one nested folder) and a list of nine public Spanish Wikipedia articles to try, two of them controls (`4c01141`).
  - `tests/first_suggestion.test.ts` runs the README path offline: demo vault indexed, article ingested and evaluated, one pending suggestion, nothing in the vault until accepted, one callout after accepting, no suggestion for the control article (`3ff5bad`).
  - `pnpm preflight` checks Node, `.env`, Postgres, migrations, Ollama and its models, the vault and the active providers, and prints the fix command for each problem; `start.sh` and `start.bat` run it and stop on a failed migration (`13a2715`). The script is not called `doctor` because pnpm already has a built-in `pnpm doctor` that silently ran instead of mine.
  - Discarding takes an optional reason (migration 0007, a select next to the button), so the user test can count why suggestions are rejected (`b35a5ab`). Callout dates are now `dd/mm/yyyy` whatever the machine locale (`2439d98`).
  - `pnpm usertest:stats` prints counts only (acceptance rate, discard reasons, time to the first suggestion) from the tester's own database (`90ec0e5`). `docs/USER_TEST.md` defines the session and `docs/DEMO.md` the shot list (`cd56cd5`).
  - Followed the README in a fresh clone of the committed code, with its own Postgres volume and only local models (no cloud key), then deleted that throwaway setup. It found two problems: `./start.sh` was not executable in git, and trying the demo left an untracked `suggestions.md` in the repository (now git-ignored).
- **Alternatives considered:** a full `docker compose up` that also runs the app and Ollama (about 6 GB of downloads, and Ollama on CPU in Docker makes the local model slow); reason chips instead of a select (more UI for the same data); computing time to the first accepted suggestion from the database (not reliable, see below).
- **Evidence:** commits above; the clean-clone run: 9 articles produced 1 `actionable`, 5 `tentative` and no suggestion on the two controls, with `qwen2.5:7b-instruct` only. The first suggestion appeared 201 s after the first demo clip. One run on one Linux machine: not a benchmark.
- **Outcome / lesson:**
  - Time to the first accepted suggestion is not taken from the database: `resolved_at` is written by Node and `created_at` by the database clock, and they differ by the machine's UTC offset. The user test takes that time with a stopwatch.
  - The clean-clone server also received a stray clip I did not send (presumably the browser extension's offline queue). It was processed locally into the throwaway database. Anyone running a second instance next to a real one should expect that.
  - One of the 267 tests failed in each of two files during the first coverage run, while the clean-clone server and Ollama were busy on the same machine; both pass alone and in two further full runs. Not reproduced, so not diagnosed.
  - Still open for the owner: recording the demo, running 3 to 5 user sessions, and trying `start.bat` on Windows. The README says "not measured" for real-user results and "not tested" for Windows.

### 2026-10-19 — Phase 6.5: bilingual Loom, and which language the model should think in
- **Context:** Loom was Spanish-only because the owner writes in Spanish, though they read in English and Spanish. The public repo and the LinkedIn post target English readers, who should be able to run the demo end to end in English. The owner proposed three settings: interface language, response language, and an internal language "in the most suitable/quality way".
- **What happened:**
  - Three languages, read at call time (`dc7d9d6`). `OUTPUT_LANGUAGE` covers what the user reads. `NOTES_LANGUAGE` covers summaries: the summary is what gets embedded against the notes, so it should be in the notes' language. `PROMPT_LANGUAGE` covers the instructions and is internal, set only by evals. `LANGUAGE` presets the first two. With everything Spanish the prompts are byte-identical to the measured ones, and the eval replay (keyed by exact prompt) proves it. This is why the "answer in X" line was parametrized in place instead of being appended centrally: a central rule would have changed every Spanish prompt and invalidated the baseline.
  - Fixed text Loom writes itself (callout labels, generated-note headings, placeholder observations) moved to `src/i18n/serverText.ts`.
  - The disguised-discard filter read the model's Spanish ("descartar"), so English output would have slipped past it. It now reads both languages.
  - A settings API persisted to `.env` (`701128f`). API messages are now English with stable error codes, and the UI translates the codes (`f30371b`).
  - A bilingual web UI (`web/i18n.js`, `54c3e7f`); an English demo vault, and a fresh clone defaults to English (`695fdec`); language fields in eval configs (`c141dc5`). The start scripts now print English.
  - Experiments on the labeled private set: DeepSeek Flash, top-3, one run each (`9022af2`, `f65202c`):

    | Change from the Spanish baseline (macro-F1 0.78) | Macro-F1 | `actionable` recall | Target note | Retrieval recall@3 / false retrieval |
    |---|---|---|---|---|
    | E1 English output | 0.76 | 26/31 (same) | 8/19 (same) | unchanged |
    | E2 English summaries vs Spanish notes | 0.73 | 24/31 | 7/19 | 91% → 88% / 94% → 83% |
    | E3 English instructions | 0.73 | 21/31 | 7/19 | unchanged |

  - Clean clone with `LANGUAGE=en` and no cloud key, on local Qwen: English summaries, suggestions and callouts. The 9 English articles produced 1 actionable, 7 tentative, and nothing for the 2 controls; the first suggestion came after 173 s.
- **Alternatives considered:**
  - One central "answer in X" rule appended to every prompt. Rejected because it breaks the measured baseline.
  - Summaries in the output language. Rejected: E2 shows it loses relevant matches against Spanish notes.
  - Switching the instructions to English, the usual advice. E3 measured it as worse here.
- **Evidence:**
  - Tests: `tests/language.test.ts`, `tests/language_settings.test.ts`, `tests/ui_i18n.test.ts`, `tests/ui_xss.test.ts` (both interface languages), `tests/first_suggestion_en.test.ts`, `tests/eval_languages.test.ts`, `tests/eval_cache.test.ts`.
  - The three result files in `evals/results/`; `evals/REPORT.md`.
  - E3 is marked "dirty tree" only because E1's result file was still uncommitted when it ran; no code changed between the two.
- **Outcome / lesson:**
  - English output is free: the actionable verdicts were identical to the Spanish baseline.
  - English instructions made DeepSeek more reluctant to call an article actionable (21 of 31 instead of 26). The instruction language is a model setting to measure, not a style choice.
  - Summarizing every article into the notes' language had been quietly doing cross-language retrieval for the owner, who reads in English but writes in Spanish. Measured, it is worth keeping.
  - These are single runs on one person's labels; run-to-run variance is still not measured. English notes with English labels were not measured.
  - The machine crashed during E2. It showed that eval caches holding paid-for answers were rewritten in place; they are now written atomically (`c878b19`). The run resumed from the cache.
  - DeepSeek spend for the three experiments, from the result files: about $0.39 at list price ($0.11 + $0.11 + $0.17). The 16 calls made before the crash and replayed afterwards are not in that figure. The running total is about $0.75 of the $2 credit (an estimate from token counts, not a billed amount).

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
| F-27 | Logs printed article URLs, project titles, note paths and raw error objects, with no way to correlate lines of one job | Phase 0 audit | Low | `b4e2fd8`, `5c5013c`, `72e6cc8` | `tests/logger_redaction.test.ts`, `tests/pipeline_trace.test.ts` |
| F-09 | Evaluator LLM failures were swallowed: no telemetry (fixed in Phase 4) and no retry (fixed in Phase 5) | Phase 0 audit | Medium | `599685c`, `72e6cc8`, `ff2f275` | `tests/failure_evaluation.test.ts`, `tests/pipeline_trace.test.ts` |
| F-12 | Untrusted text pasted into prompts inside unescaped tags; no rule that delimited content is data | Phase 0 audit | Medium | `da9b686` | `tests/failure_injection.test.ts` |
| F-13 | Model-written `targetFile` stored unvalidated and used as a `LIKE` pattern in staleness checks | Phase 0 audit | Medium | `d3d2955` | `tests/failure_target_path.test.ts` |
| F-23 | Four test files needed a live Ollama; no fake provider | Phase 0 audit | Medium | `c88d93c` | the whole suite passes with `OLLAMA_URL` on a closed port (CI) |
| F-24 | Production dependency `@fastify/static` 8 had one high and three moderate advisories | Phase 0 audit | Low | `50b52ea` | `pnpm audit --prod --audit-level high` in CI |
| — | An interrupted evaluation could leave an actionable evaluation without its suggestion; every retry skipped the pair | Writing failure scenario 3 | Medium | `7beb8f3` | `tests/failure_jobs.test.ts` (fails on the old code) |
| — | `singletonKey` on job sends never de-duplicated (pg-boss standard-policy queues); duplicates were harmless only because handlers are idempotent | Checked while writing scenario 3 | Low | `ff2f275` | `tests/failure_jobs.test.ts` (duplicate and concurrent runs) |
| — | A test could bind the DB pool to the development database by importing `src/db` before stubbing its container URL; it did once (3 fake rows, deleted by the owner) | Full test run after adding the guard | Medium (process) | `0efbec4` | every DB test now fails against the closed default port if it forgets the stub |
| — | `./start.sh` and `./reset_db.sh` were not executable in git, so the README's first command failed on a fresh clone | Following the README in a clean clone | Low | `cd56cd5` | not testable in the suite; verified with `git ls-files -s` |
| — | `start.sh` and `start.bat` kept going after a failed migration | Phase 6 review of the scripts | Low | `13a2715` | none (shell scripts); `pnpm preflight` catches the resulting missing schema (`tests/doctor.test.ts`) |
| — | Accepted callouts used the machine locale for the date (`10/18/2026` in a Spanish vault) | Owner noticed in Phase 5 | Low | `2439d98` | `tests/vault_sanitize.test.ts` (callout date) |
| — | Reading a saved synergy note back put the note body into the last "mutual benefits" bullet | Writing the bilingual round-trip test | Low | `f30371b` | `tests/language.test.ts` (saved synergy notes) |
| — | The disguised-discard filter matched only Spanish model text; with English output an "actionable" answer saying "discard the article" would have become a suggestion | Reading the code for Phase 6.5 | Medium | `dc7d9d6` | `tests/language.test.ts`, `tests/evaluation.test.ts` (English discard) |
| — | The ingestion worker decided which failures not to retry by matching Spanish error text, so translating a message would silently enable retries | Translating the messages | Low | `f30371b` (matches both) | none (regex over messages) |
| — | Eval caches of paid-for model answers were rewritten in place; a crash mid-write would lose them | A machine crash during a live run | Low | `c878b19` | `tests/eval_cache.test.ts` |
| — | The extension guide showed the owner's home path, and the vault placeholder showed a username | Translating the UI | Low | `54c3e7f` | `tests/ui_i18n.test.ts` (static page) |

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
| 2026-10-18 | Send only the 3 closest projects to the LLM (replay) | LLM calls / DeepSeek macro-F1 / `actionable` recall / triage cost | 215 / 0.74 / 97% / about $0.18 | 118 / 0.79 / 87% / about $0.11 | `pnpm eval run evals/private --config evals/configs/deepseek-flash-top3.json --replay` |
| 2026-10-18 | DeepSeek spend | Estimated list-price cost, 215 triage calls | not measured | about $0.18 (summaries about $0.06 more) | token counts in the result files; not a billed amount |
| 2026-10-18 | Phase 3 tests | Tests passed / skipped, hermetic (live Ollama, no cloud keys) | 123 / 1 | 186 / 2 | `pnpm test:coverage`; lines 84.06% → 85.28% |
| 2026-10-18 | Phase 4 tests | Tests passed / skipped, hermetic (live Ollama, no cloud keys) | 186 / 2 | 210 / 2 | `pnpm test:coverage`; lines 85.28% → 86.44% (branches 71.84%, functions 84.53%) |
| 2026-10-18 | Phase 5 prompts (live re-run, top-3) | Triage macro-F1, DeepSeek / Gemini / Qwen | 0.79 / 0.61 / 0.61 (replay, Phase 3 prompts) | 0.78 / 0.67 / 0.63 | `pnpm eval run evals/private --config evals/configs/<config>-top3.json --replay` at `ce14538` or later |
| 2026-10-18 | Phase 5 tests | Tests passed / skipped / line coverage | 210 / 2 / 86.44% (with live Ollama) | 241 / 4 / 88.37% (no Ollama, no keys; branches 74.89%, functions 86.55%) | `pnpm test:coverage`; the skipped tests are the opt-in live checks |
| 2026-10-18 | Phase 5 | Test files that need a live model (without `LOOM_LIVE_TESTS`) | 5 (`evaluation`, `ingestion`, `phase7_ui`, `settings_vault`, `ollama`) | 0 | `OLLAMA_URL=http://127.0.0.1:9 pnpm test` |
| 2026-10-18 | Phase 5 | Production dependency advisories | 4 (1 high, 3 moderate) | 0 | `pnpm audit --prod` |
| 2026-10-18 | Target-note validation (replay, top-3 configs) | Target-note accuracy, Gemini / DeepSeek / Qwen | 7/19 / 8/19 / 6/19 | 9/19 / 8/19 / 6/19 | `pnpm eval run evals/private --config evals/configs/<config>-top3.json --replay` at `d3d2955`; result files `*d3d2955*` |
| 2026-10-18 | Phase 4 | LLM calls with telemetry (of 6 call sites) / attempts recorded on failure | 1 (triage, success only) / no | 6 / yes | `grep -n "component: '" src`; `tests/llm_telemetry.test.ts` |
| 2026-10-17 | Phase 2 fixes | `tests/full_e2e.test.ts` with the Gemini key set | 1 / 0 / 0 | 1 / 0 / 0, served by Ollama after two Gemini HTTP 503 responses | `pnpm vitest run tests/full_e2e.test.ts` |
| 2026-10-19 | Phase 6 demo vault | Projects / notes in `demo_vault/` | 1 / 1 | 4 / 15 | `find demo_vault -name '*.md'` |
| 2026-10-19 | Phase 6 tests | Tests passed / skipped / line coverage | 242 / 4 / 88.37% | 267 / 4 / 88.33% (branches 75.96%) | `pnpm test:coverage` (no Ollama, no keys) |
| 2026-10-19 | Phase 6 clean-clone run (one run, local qwen2.5:7b-instruct only) | Seconds from first clip to first suggestion / suggestions from 9 demo articles | not measured | 201 s / 1 actionable, 5 tentative, 0 on the 2 controls | steps in `docs/DEMO.md` and `demo_vault/ARTICULOS_DEMO.md`; `pnpm usertest:stats` |
| 2026-10-19 | Phase 6 user test | Testers run, acceptance rate, rejection reasons | not measured | not measured | `docs/USER_TEST.md` |
| 2026-10-19 | Phase 6.5 languages (one run each, DeepSeek Flash top-3) | Macro-F1 / `actionable` recall: English output, English summaries, English instructions | 0.78 / 26 of 31 (Spanish baseline) | 0.76 / 26, 0.73 / 24, 0.73 / 21 | `pnpm eval run evals/private --config evals/configs/deepseek-flash-top3-{output,summary,prompt}-en.json --replay` |
| 2026-10-19 | Phase 6.5 English clean-clone run (local Qwen) | Suggestions from 9 English demo articles / seconds to first suggestion | not measured | 1 actionable, 7 tentative, 0 on the 2 controls / 173 s | `docs/DEMO.md` steps with `LANGUAGE=en`; `pnpm usertest:stats` |
| 2026-10-19 | DeepSeek spend | Estimated list-price cost, total so far | about $0.36 | about $0.75 of $2 | token counts in the result files; not a billed amount |

## Dead ends and things that did not work

- **ONNX embeddings in Node (`@huggingface/transformers`, `paraphrase-multilingual-MiniLM-L12-v2`):** the Phase 0 spike recorded ≈665 MB RSS against a 500 MB budget, a NO-GO (ADR 002; this number was not re-measured). Loom moved to Ollama `bge-m3`. The spike code was removed in `7c1eb33`.
- **"Ask My Library" (top-5 RAG with `[1]`, `[2]` citations):** replaced by the full-catalog Consultor, then removed in `07f0890`. Open question for Phase 3: the Consultor sends the whole catalog in one prompt, which will not scale.
- **Recording an eval fixture with a throwaway script:** the first attempt (a top-level-await `.ts` file) failed on the CJS output format and went against the owner's rule that checks live in the project; the CLI's `--record` flag replaced it.
- **Evaluating the production chain as one unit:** fallbacks hid which model had answered; evals use one provider per config.
- **Bookmarklet clipper:** convenient, but it required an open CORS policy on `/api/ingest`. Removed in favor of the extension (`7be41b1`).
