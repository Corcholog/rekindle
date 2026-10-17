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

## Bugs and vulnerabilities found

| ID | What was wrong | How it was found | Severity | Fixed in | Test that proves the fix |
|---|---|---|---|---|---|

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

## Dead ends and things that did not work

- **ONNX embeddings in Node (`@huggingface/transformers`, `paraphrase-multilingual-MiniLM-L12-v2`):** the Phase 0 spike recorded ≈665 MB RSS against a 500 MB budget, a NO-GO (ADR 002; this number was not re-measured). Loom moved to Ollama `bge-m3`. The spike code was removed in `7c1eb33`.
- **"Ask My Library" (top-5 RAG with `[1]`, `[2]` citations):** replaced by the full-catalog Consultor, then removed in `07f0890`. Open question for Phase 3: the Consultor sends the whole catalog in one prompt, which will not scale.
- **Bookmarklet clipper:** convenient, but it required an open CORS policy on `/api/ingest`. Removed in favor of the extension (`7be41b1`).
