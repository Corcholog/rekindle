# Code review — findings and current status

Original review: 2026-10-14, against the pre-hardening code. Hardening landed in three commits:
`f1e6620` (P1 fixes), `094c5d3` (P2 reliability/performance), `855e4f6` (P3 refactor: central config,
shared AI provider, lint/typecheck).
Status below was **checked by reading the current source** (typecheck, lint and the 9 offline unit
tests pass; integration tests were not run because they need Docker/Ollama).

Legend: ✅ fixed · 🟡 partly fixed · ❌ open · 🆕 new issue introduced or discovered after the fixes

## P1 — bugs and risks

| # | Finding | Status | Where / notes |
|---|---|---|---|
| 1 | Server bound to `0.0.0.0`, no auth | 🟡 | `HOST` defaults to `127.0.0.1` (`src/config.ts`). Still no auth. |
| 2 | Any URL scheme accepted; fetch without limits | 🟡 | `http(s)` only (`ingest.ts`), `safeUrl` in the UI, 15 s timeout / 5 MB / content-type check (`ingestionWorker.ts`). Private/loopback hosts not blocked. |
| 3 | Embedding failure was permanent | ✅ | `reconciler.ts`: no persistence on failure; re-embeds when latest snapshot has no embedding; DB transaction. |
| 4 | Hash covered irrelevant files; read whole files | ✅ | `hash.ts`: top-level `.md` only, file names included, streamed. (One-time resync on upgrade.) |
| 5 | Ollama context window unset | ✅ | `numCtx: 16384`; evaluator caps notes (15k) and summary (10k chars). |
| 6 | Gemini called with `responseSchema`; system prompt concatenated | ✅ | `responseJsonSchema` + `systemInstruction`; `lastUsedModel` stored in telemetry. |
| 7 | Untrusted summary in system prompt | ✅ | Evaluator moves project + article into the user message inside tags. |
| 8 | Multi-line text broke callouts | ✅ | `formatAcceptedCallout` prefixes every line, escapes link text/URL. |
| 9 | Double-accept of tentative item duplicated suggestions | 🟡 | Idempotent by `evaluation_id`. 🆕 **K1**: accept no longer touches the evaluation, so it can stay listed as *tentative*. Discard still overwrites the LLM verdict. |
| 10 | `?isActive=false` returned active | ✅ | `z.enum(['true','false']).transform(...)`. |
| 11 | Watcher ignored dot-parent vaults, no error handler, no `unlinkDir` | ✅ | Relative `ignored` function, `error`/`unlinkDir` handlers, `suggestions.md` skipped. |
| 12 | Wrong pino call signature | ✅ | `server.log.error({ err }, msg)`. |
| 13 | Parser regex bugs | ✅ | Anchored frontmatter/headers, code stripped before title, `.md$` fallback, warning on failure. |

## P2 — reliability and performance

| Finding | Status | Notes |
|---|---|---|
| Evaluator swallowed all insert errors | ✅ | Only `23505` treated as duplicate. |
| `/api/projects` N+1 queries, heavy selects | ✅ (list) | Batched; detail endpoint still issues several small queries. |
| Settings GET N+1 | ✅ | One grouped count query. |
| `hasSpatialAffinity` scanned all snapshots | ✅ | Uses latest snapshot per active project (still a correlated subquery per row). |
| Suggestions list paginated in memory | ✅ | SQL `UNION ALL` with `LIMIT/OFFSET` and count. |
| `POST /api/settings/vault` blocked and double-reconciled | 🟡 | Watcher restart skips boot reconcile; request still waits for the full reconcile. |
| Ingest race on unique `uri` | ✅ | `ON CONFLICT DO UPDATE`. |
| Writeback race | 🟡 | Single write is an atomic claim; `syncProjectSuggestions` is still read–append–update. |
| No per-project reconcile lock | 🟡 | Lock added, but a skipped call is dropped, not queued (**K3**). |
| Duplicate jobs / pointless retries | ✅ | `singletonKey`, `retryLimit`, non-retryable error regex (fragile by design). |
| No graceful shutdown | ✅ | `stopServer` on SIGINT/SIGTERM. |
| 500 handler leaked messages | ✅ | Generic message. |
| Frontend polling while hidden | ✅ | Skips when `document.hidden`, non-overlapping. |
| URL canonicalisation only for YouTube | ✅ | `canonicalizeUrl` (tracking params, fragment, trailing slash, YouTube variants). |
| Dead schema (`llm_telemetry`, `consumptionSeq`) | 🟡 | `consumption_seq` incremented on re-ingest; telemetry written for `triage` only (model + latency). |

## P3 — maintainability

| Finding | Status | Notes |
|---|---|---|
| Config scattered | 🟡 | `src/config.ts` + shared `sharedAiProvider`. Still direct `process.env` reads for `GEMINI_MODEL`, `LOG_LEVEL`, runtime `VAULT_PATH`; Ollama chat model hard-coded. |
| Provider naming | 🟡 | `AiProvider` alias exported; class still `OllamaProvider`. |
| `.env.example` / model-name mismatch | ✅ | Refreshed in this documentation pass. |
| `as any`, untyped jobs | 🟡 | ESLint allows `any`; workers still type jobs as `any`. |
| Schema: tz-less timestamps, FK indexes, `updatedAt` | ❌ | Unchanged. |
| ESLint config, `typecheck` script, tsconfig | ✅ | Added; `tsc` uses `bundler` resolution. |
| Tests need Docker/Ollama, no mock provider | ❌ | Unchanged. |
| Git repo, stray `query` file, README | ✅ | Repo initialised, file removed, README written. |
| Unused devDependencies | ❌ | `@huggingface/transformers`, `ollama`, `ts-node` remain (spikes). |
| Google Fonts from CDN, monolithic `app.js` | ❌ | Unchanged. |

## Open items worth doing next

1. K1: add `user_decision` (or similar) to `evaluations`/new table; stop mutating `verdict`.
2. Decide the cloud-privacy contract (ADR 001 A9 vs. sending notes to Gemini); document or enforce.
3. Queue instead of drop a reconcile requested while one is running.
4. Make `syncProjectSuggestions` claim rows atomically.
5. Add unit tests: callout formatting, `canonicalizeUrl`, `getDirectoryHash`, parser edge cases, `isActive` query parsing; add a fake AI provider for integration tests.
6. Optional hardening: block private IPs in the fetcher, add an auth token, bind Postgres to localhost in `docker-compose.yml`.
