# Rekindle threat model

Rekindle is a single-user tool that runs on the owner's machine. It reads web pages and the owner's Obsidian vault, asks LLMs for suggestions, and writes to the vault only when the owner accepts one. This document lists what is worth protecting, where untrusted data comes from, what stops each threat, and which test proves it. It follows the threat model in `docs/agent/01-audit.md` and the Phase 0 audit findings (F-numbers).

Last reviewed: 2026-10-19 (Phase 6.5, languages).

## Assets

| Asset | Why it matters |
|---|---|
| **Vault integrity** | The owner's notes are the product of years of work. Rekindle must never overwrite, corrupt or silently add to them. |
| **Private notes and reading history** | Note text, project names and the list of ingested URLs are personal. They reach an LLM provider only when the owner configures one. |
| **API keys** | `DEEPSEEK_API_KEY` and `GEMINI_API_KEY` in `.env` cost money if leaked. |
| **Local files and the local network** | Rekindle fetches URLs on the owner's behalf; it must not become a way to read local files or reach services on the LAN. |
| **Trust in suggestions** | A suggestion is useful only if the owner can believe where it came from and where it points. |

## Untrusted inputs

1. **Web pages, titles, YouTube transcripts and metadata** that the owner clips.
2. **LLM output**: summaries, verdicts, suggested actions, target notes, Consultor and synergy answers. It is derived from (1) and (6), so it is treated as untrusted too.
3. **Any website open in the owner's browser**, which can send requests to `127.0.0.1` (CSRF, DNS rebinding).
4. **Other devices on the network**, if the server were bound to a non-loopback address.
5. **Messages from the browser extension.**
6. **Note content** in the vault, which can contain text pasted from elsewhere.

## Trust boundaries

```
 browser tab ──(3)──▶  local API (Fastify, loopback only)  ◀──(5)── extension
                              │
 web (1) ◀── safe fetch ──────┤
                              ├── prompts ──▶ LLM providers (DeepSeek / Gemini / local Ollama)
                              │                     │
 vault notes (6) ── reconciler ┤        (2) LLM output ──▶ database ──▶ web UI (escaped)
                              │                                    └──▶ vault, only on accept (sanitized)
                              └── logs / telemetry (IDs and numbers only)
```

## Threats, mitigations and the tests that prove them

| # | Threat | Input | Mitigation | Code | Test |
|---|---|---|---|---|---|
| T1 | A web page uses DNS rebinding or CSRF to read notes or accept suggestions through the local API (F-01, F-02, F-11) | 3 | Requests must carry a loopback `Host`; state-changing requests need the UI's own `Origin` (other local ports are rejected); the extension origin may only call `/api/ingest`; no wildcard CORS | `src/api/requestGuard.ts` | `tests/request_guard.test.ts`; `tests/phase7_ui.test.ts` (K4, Feature 2) |
| T2 | Another device on the network reaches the API or the database | 4 | `HOST` must be `127.0.0.1`, `localhost` or `::1` or the server refuses to start; Docker publishes Postgres on `127.0.0.1` only (F-22) | `src/config.ts`, `docker-compose.yml` | `tests/request_guard.test.ts` ("refuses a non-loopback HOST binding"); compose binding verified with `docker compose config` (no test) |
| T3 | Server-side request forgery: a clipped URL or a redirect reaches a local or private service, or a huge body exhausts memory (F-05) | 1, 3 | Only `http(s)`; every resolved IP checked at connect time against private, loopback, link-local, CGNAT, multicast, ULA and IPv4-mapped ranges; redirects followed manually (max 5) and re-checked; body streamed with a 5 MB cap; private hosts rejected at the API boundary too | `src/net/safeFetch.ts`, `src/api/routes/ingest.ts` | `tests/safe_fetch.test.ts`; `tests/phase7_ui.test.ts` (K4 SSRF) |
| T4 | Prompt injection: a page or a note tells the model to ignore its rules, break out of its delimiters, or produce harmful output; a stored summary carries the injection into later prompts (F-12) | 1, 6, 2 | Every untrusted block goes through `promptBlock`, which neutralizes tag-like sequences so content cannot close or open a block; every system prompt ends with a rule that delimited content is data, not instructions; the summarizer is told not to carry instructions into summaries. The output-language line is fixed text chosen by a setting, never by content. These only make injection harder: T5–T7 are the real boundary | `src/ai/promptSafety.ts`, `src/ai/aiProvider.ts` | `tests/failure_injection.test.ts` |
| T5 | Model text written to the vault acts inside Obsidian: code blocks (Dataview JS), embeds, HTML, forged callouts, hidden comments (F-04) | 2 | Nothing is written unless the owner accepts (I1); accepted callouts and saved notes pass through `sanitizeForVault`; saved synergy notes and briefs are new files, never overwrites | `src/vault/sanitize.ts`, `src/vault/updater.ts`, `src/vault/generatedNotes.ts` | `tests/vault_sanitize.test.ts`, `tests/generated_notes.test.ts`, `tests/failure_injection.test.ts`; I1: `tests/phase7_ui.test.ts` (Features 4–5) |
| T6 | The model proposes a target note outside the project (`../../Personal/diario.md`) or a wildcard that matches unrelated notes (F-13) | 2 | The target note must be one of the snapshot's notes; a proposed new note must be a plain relative name inside the project (root or an existing notes folder), and is only ever a link, never created; otherwise the retrieved note is used; accepted callouts always go to `<project>/suggestions.md`; `LIKE` wildcards in stored targets are escaped | `src/evaluator/targetFile.ts`, `src/api/routes/suggestions.ts` | `tests/failure_target_path.test.ts` |
| T7 | A generated note name or the vault-path setting escapes the vault or injects lines into `.env` (F-10) | 2, 3 | Generated notes are confined to the vault and use exclusive-create; the vault path is checked for control characters, written atomically with mode 0600, and must exist | `src/vault/generatedNotes.ts`, `src/vault/config.ts` | `tests/generated_notes.test.ts`, `tests/env_writer.test.ts`, `tests/settings_vault.test.ts` |
| T8 | A symlink inside a project pulls a file from outside the vault into prompts | 6 | The reconciler's walk skips symlinked files and folders; hidden folders (`.obsidian`) are ignored | `src/vault/reconciler.ts`, `src/vault/watcher.ts` | `tests/failure_reconcile.test.ts` (symlinks), `tests/invariants.test.ts` (I4) |
| T9 | Page titles, notes or model output become HTML or script in the web UI | 1, 2, 6 | The UI is React: all text is escaped; no component uses `dangerouslySetInnerHTML` or `innerHTML`; only http(s) URLs become an `href`; the eval review page uses `textContent` only | `web/src/`, `evals/review/app.js` | `tests/ui_xss.test.ts` (built bundle, both languages and themes), `tests/ui_i18n.test.ts` (no HTML rendering), `tests/eval_review_ui.test.ts` |
| T10 | A malicious extension message or page script abuses the extension | 5 | Host permissions limited to `localhost:3000`/`127.0.0.1:3000`; no `externally_connectable`; the extension origin may only call `/api/ingest` | `extension/manifest.json`, `src/api/requestGuard.ts` | `tests/request_guard.test.ts` (extension origin), `tests/extension_offline.test.ts` (manifest) |
| T11 | Note text, article text, prompts, URLs or error details leak into logs, telemetry or HTTP errors (F-26, F-27) | 1, 2, 6 | One redacting logger (text-like fields censored at any depth, errors reduced to name/kind/status); telemetry stores IDs, counts, lengths and hashes; 500 responses are generic | `src/observability/logger.ts`, `src/observability/llmTelemetry.ts`, `src/api/server.ts` | `tests/logger_redaction.test.ts`, `tests/pipeline_trace.test.ts`, `tests/error_responses.test.ts` |
| T12 | Notes reach a cloud LLM without the owner choosing it; embeddings leave the machine | — | No cloud LLM traffic without a cloud key (I2); embeddings are always computed by local Ollama (I3) | `src/ai/chain.ts`, `src/ai/aiProvider.ts` | `tests/invariants.test.ts` |
| T13 | API keys leak through git or tests | — | `.env` is git-ignored; tests blank the cloud keys and point `DATABASE_URL` and `OLLAMA_URL` at closed ports unless `REKINDLE_LIVE_TESTS=1`; no code path logs the keys (checked by reading, not by a test) | `.gitignore`, `vitest.config.ts` | `tests/invariants.test.ts` (no cloud traffic with blank keys); key logging: no test |
| T14 | A crash, retry or race duplicates or loses a vault write, a suggestion or an evaluation (F-06, F-07, F-08, I5, I6) | — | Callouts carry a `%% rekindle:<id> %%` marker and are written under `SELECT … FOR UPDATE` with boot recovery; one suggestion per evaluation (unique index); an evaluation and its suggestion are written in one transaction; re-ingesting never re-evaluates | `src/vault/updater.ts`, `src/evaluator/index.ts`, `src/api/routes/ingest.ts` | `tests/writeback_recovery.test.ts`, `tests/tentative_accept_race.test.ts`, `tests/reingest_idempotency.test.ts`, `tests/failure_jobs.test.ts` |
| T15 | Model failures silently drop evaluations, so the owner trusts an incomplete picture (F-09) | 2 | Failed project evaluations fail the job, which is retried with backoff; every attempt and failure is recorded and shown by `pnpm telemetry:report` | `src/workers/evaluationWorker.ts`, `src/observability/` | `tests/failure_evaluation.test.ts` |
| T16 | A vulnerable or malicious dependency | — | `pnpm audit --prod --audit-level high` in CI; GitHub Actions pinned to commit SHAs with a read-only token; pnpm runs install scripts only for an allowlist | `.github/workflows/ci.yml`, `pnpm-workspace.yaml` | CI job (not a unit test) |
| T17 | Oversized or junk input drains the cloud provider's balance or the machine's memory: a huge clipped selection, a multi-megabyte note, a pasted image as base64 | 1, 5 | Articles, transcripts and selections are cut at 50,000 characters, and the summarizer cuts its own input; the extension cuts selections before sending and `/api/ingest` refuses bodies over 256 KB; notes over 2 MB are not read, binary notes are left out, embedded base64 is removed, and each prompt carries at most 60,000 characters of notes; left-out notes are shown to the owner. The Consultor still sends the whole library per question (residual risks, below) | `src/workers/ingestionWorker.ts`, `src/ai/summarize.ts`, `src/api/routes/ingest.ts`, `extension/`, `src/vault/parser.ts`, `src/evaluator/notesContext.ts` | `tests/article_limits.test.ts`, `tests/parser.test.ts`, `tests/full_notes.test.ts`, `tests/notes_context.test.ts` |

## Audit failure scenarios

The Phase 0 audit (kept locally) listed eight failure scenarios. Each has a test:

| # | Scenario | Test |
|---|---|---|
| 1 | The LLM returns invalid structured output or times out | `tests/failure_evaluation.test.ts`, `tests/providers.test.ts` |
| 2 | Every LLM provider fails | `tests/failure_evaluation.test.ts` |
| 3 | A queued job runs twice, concurrently, or is interrupted | `tests/failure_jobs.test.ts` |
| 4 | Obsidian changes a note while Rekindle reconciles it | `tests/failure_reconcile.test.ts` |
| 5 | An accepted suggestion's disk write fails | `tests/writeback_recovery.test.ts` |
| 6 | Retrieved content contains prompt-injection instructions | `tests/failure_injection.test.ts` |
| 7 | URL fetching targets a private service or abuses redirects | `tests/safe_fetch.test.ts` |
| 8 | The LLM supplies a target path outside the project | `tests/failure_target_path.test.ts` |

## Residual risks

These are known and accepted for a single-user local tool, or not fixed yet:

- **No authentication.** Any process running as any user on the same machine can call the loopback API. A per-install token would close this if LAN access is ever needed.
- **Prompt injection can still steer what the model says.** The defenses keep the prompt structure intact and keep the model's output inside code-enforced limits, but an injected page can still bias a verdict or the wording of a suggestion. The owner's review before accepting is the control. How often injection succeeds against each model is **not measured**.
- **Cloud providers see notes when a key is set.** With `DEEPSEEK_API_KEY` or `GEMINI_API_KEY`, article text, summaries and up to 60,000 characters of project notes per evaluation leave the machine (README, Privacy note). Leaving both keys empty keeps every model call local.
- **The Consultor sends the whole library in one prompt** (F-16): a large privacy surface when a cloud key is set, a cost that grows with every saved article and note on each question, and silent truncation on the local model. A retrieval-first Consultor with a budget is planned (T17).
- **Synergies may use notes from older snapshots** (F-14), including deleted notes.
- **Unmounting the vault drive can trigger a burst of backlog jobs** on remount (F-15).
- **The extension can send a queued clip twice** (F-21). Re-ingesting is harmless (I6).
- **Unicode normalization and platform path differences** in vault sync (F-28) and regex denial of service in the parser were not tested.
- **Development dependencies** are not audited in CI (only production ones are).
