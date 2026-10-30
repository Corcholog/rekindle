> Historical artifact: the prompt used for the read-only audit of 2026-10-17, kept for transparency.

# Phase 0 — Read-Only Engineering & Security Audit

Act as a senior software and security engineer auditing Loom (TypeScript, Fastify, PostgreSQL/pgvector, Drizzle, pg-boss, Ollama, optional Gemini, Obsidian vault integration, Manifest V3 extension, vanilla-JS web UI).

First read `CLAUDE.md` and `docs/agent/00-goals-and-context.md`. The goal is a clean, trustworthy, publishable version of the project, so this audit covers correctness and security **and** leftover code from earlier iterations.

## Rules

- Read-only on the repository. The only file you may create is `docs/audit/AUDIT_REPORT.md` (the owner will git-ignore it until the findings are fixed). Do not edit, create, delete, or reformat anything else.
- Never read or print values from `.env` or any secret. If you find a secret in code, config, or git history, report only its location, redacted.
- Do not start the server, workers, or watcher. Do not run migrations, seeds, resets, or anything touching the dev database, the real vault, Ollama, Gemini, or application network calls.
- Allowed: static inspection, `git log/diff/blame/grep`, `tsc --noEmit`, `eslint`, offline unit tests, `pnpm audit`, and one-off analysis tools run without installing them into the repo (for example `pnpm dlx knip`, `pnpm dlx depcheck`). Do not modify `package.json` or the lockfile. Integration tests only if they use throwaway Testcontainers and cannot touch the dev DB; otherwise report them as unverified.
- Treat the architecture document as a set of claims to verify, not as truth. Read the actual source, tests, migrations, and config.
- Every finding needs code evidence (file path, line numbers, short excerpt). No evidence, no finding. Mark uncertainty explicitly; never present speculation as fact.
- Do not fix or remove anything. Stop after delivering the report and wait for the owner's review.

## Phase 0.5 — Map before judging

Build an as-implemented map before auditing: every entry point (HTTP routes, queue handlers, watcher events, extension messages, `package.json` scripts, standalone scripts), every filesystem write path, every outbound network call, every place text reaches an LLM prompt, and every place LLM output reaches the DB, the vault, or the UI. Use this map to drive the audit; it is also the reachability baseline for Area 8.

## Threat model

Assets: vault integrity, private notes, API keys, local files, trust in suggestions.

Untrusted inputs: (1) web pages, titles, YouTube transcripts and metadata; (2) LLM output; (3) any website open in the user's browser calling localhost (CSRF, DNS rebinding); (4) other devices if `HOST` is changed to `0.0.0.0`; (5) extension messages; (6) note content containing pasted external text.

## Audit areas

### 1. Security
- SSRF in ingestion: redirects, DNS rebinding, IPv6 and IPv4-mapped addresses, private/loopback/link-local ranges, non-HTTP schemes, size and time limits, decompression bombs.
- Path traversal and symlinks: `targetFile`, note paths, watcher following symlinks outside the vault, the vault-path setting.
- `POST /api/settings/vault` and `.env` writing: newline/variable injection, races, file permissions.
- Localhost API: Host/Origin validation, CORS, CSRF, authentication, binding, rate limiting.
- Web UI: XSS (innerHTML, markdown rendering of summaries, titles, note previews).
- Extension: permissions, host permissions, message handling, storage, CSP.
- Error handling and logging that leak stack traces, article or note content, or keys.
- Regex and parser DoS (parser, URL normalization).

### 2. Prompt injection and untrusted LLM output (dedicated workstream)
- Map every untrusted text source that reaches a prompt: raw web text, titles, transcripts, stored summaries (second-order injection: a malicious page is summarized once, then reused in evaluator, Consultor, and synergy prompts), vault notes, prior suggestions, and user feedback.
- For each source: delimiting and escaping, instruction hierarchy, and the damage a successful injection can do.
- What can LLM output control? Verdict and confidence (forcing or suppressing suggestions); `targetFile` (traversal, wrong-note targeting); `suggestedAction` and `observation` written into the vault as markdown (callout breakout via newlines, forged callouts, `![[embeds]]`, links, HTML, dataview/dataviewjs/Templater-style code blocks that could execute in Obsidian); Consultor citations (verify cited `[C#]`/`[N#]` IDs exist in the supplied catalog); bridge-note filenames and content built from project titles.
- Output validation: schema strictness, length caps, sanitization before write and before render, behavior on parse failure, and how the 7B local fallback differs from Gemini.
- Privacy boundary: exactly what text is sent to Gemini, and whether anything leaves the machine when `GEMINI_API_KEY` is unset (including frontend requests to Google Fonts or other CDNs).

### 3. Data integrity
- Suggestion acceptance, atomic writeback, crash windows between the DB flag and the file append, duplicate or lost callouts, retries, concurrent operations, queue idempotency, `consumption_seq` races, snapshots, foreign keys and cascades, migrations vs schema drift (`drizzle-kit check`), recovery after partial failure.

### 4. Retrieval quality and AI correctness
- Threshold calibration (0.6, 0.5, 0.04, 0.08): justified, or magic numbers?
- Note-level and project-level distances compared in the same ranking.
- Whether HNSW indexes can be used given `DISTINCT ON`, joins, and `WHERE` filters; behavior when filtered HNSW returns fewer rows than `LIMIT`.
- Truncation at 4,000 characters: what is embedded vs what is stored; missing chunking.
- `embedding_model` tracking across contents, snapshots, and note snapshots; what breaks on a model change.
- Provider fallback (quota, timeouts, malformed output), retry storms, backlog re-evaluation fan-out and LLM cost, context limits, scalability of the Consultor's full-catalog context.
- False positives, stale detection, tentative promotion logic.

### 5. Filesystem synchronization
- Creation, edit, rename, deletion, ignored paths, debounce, reconciliation races, self-triggered loops from writing `suggestions.md`.
- Accented and Unicode filenames (NFC vs NFD), Windows vs Linux separators and case sensitivity, sync-conflict files, large vaults, empty or non-UTF-8 notes, removable-drive failures.
- Renames breaking `targetFile` on older suggestions.

### 6. Browser extension
- Offline persistence, duplicate prevention, retry and backoff, `chrome.storage.local` quota, server-side validation, unauthorized cross-origin requests.

### 7. Reliability and performance
- Startup and shutdown, queue recovery and poison jobs, pg-boss retry and expiry policy, concurrency limits, connection lifecycle, behavior during Ollama, Gemini, or Postgres outages, memory use on large vaults.

### 8. Dead code, legacy, and documentation drift
The project has evolved through several iterations, so assume some code, tables, and docs no longer match what the product does.
- **Method:** use the Phase 0.5 reachability map. Code not reachable from any entry point, script, or test is a candidate. Use `pnpm dlx knip` (or `ts-prune` / `depcheck`) for unused files, exports, and dependencies; `git log -1 --format=%cs -- <path>` for last-touched dates; and grep for `TODO`, `FIXME`, `HACK`, `deprecated`, `legacy`, `old`, `v1`, `tmp`, `backup`, `.bak`, `.orig`, and commented-out blocks.
- **Look for:**
  - unused files, functions, exports, and types;
  - HTTP routes that neither `web/app.js` nor the extension call;
  - superseded implementations and overlapping endpoints (for example, anything left from an earlier two-step evaluator, or `/api/library/ask` vs `/api/library/consult`);
  - old assumptions still in code (a mandatory `project.md`, the `ideas.md` fallback, hardcoded folder names);
  - unused DB tables, columns, enums, and indexes, and migrations that created things later abandoned;
  - unused env vars and config constants;
  - unused dependencies and devDependencies;
  - stale scripts (`seed`, `reset`, `reconcile_and_reevaluate`, icon generator, `start.*`, `reset_db.*`);
  - stale tests, fixtures, and mocks;
  - ADRs, phase reports, and docs that contradict the code;
  - unused UI elements, CSS, modals, and extension code or permissions.
- **Classify each item:**
  - *Safe to remove:* no references, unreachable, no tests, not in docs.
  - *Probably dead:* needs owner confirmation.
  - *Legacy but live:* still used; document it or plan a migration.
  - *Keep:* looks old but is needed (explain why).
- **DB rule:** never recommend editing an applied migration. Removal is a new migration, and data-bearing columns need an explicit data-loss note.
- **Drift table:** list every claim in the architecture document that the code does not match.
- Do not remove anything in this phase.

### 9. Dependencies and supply chain
- `pnpm audit`, lockfile hygiene, extension dependencies, unpinned versions, install scripts.

### 10. Observability and log privacy
- What is logged (content, notes, keys), redaction, what telemetry exists vs what is needed (tokens, cost, prompt version, a correlation ID from ingestion to suggestion, stage latencies, fallback and retry counts, retrieval distances).

### 11. Testing
- Compare documented guarantees against actual unit, integration, and e2e coverage; list high-value missing regression tests.
- Check whether tests exist for these failure scenarios:
  1. LLM returns invalid structured output or times out.
  2. Gemini fails and the Ollama fallback also fails.
  3. A queued job runs twice or is interrupted.
  4. Obsidian changes a note while Loom reconciles it.
  5. A suggestion is accepted but the filesystem write fails.
  6. Retrieved content contains prompt-injection instructions.
  7. URL fetching targets a private service or abuses redirects.
  8. The LLM supplies a target file path outside the project directory.
- Check whether AI behavior can be tested deterministically (a fake provider or recorded fixtures) without live API calls.

### 12. Usability (heuristic, since this is static inspection)
- Onboarding, first useful result, error states for missing Ollama/models/vault, suggestion explainability ("why this matched"), clarity of accept and writeback, error recovery, Spanish-language consistency, accessibility basics.

### 13. AI-engineering readiness (assessment and design only, no implementation)
- Assess gaps in evaluation, observability, retrieval architecture, agent/tool use, and deployment.
- Review the eval design in `docs/agent/02-roadmap.md` (Phase 3) against the real code: can each metric be computed from the current schema and interfaces? What is the smallest change that makes it measurable?
- Propose designs for: an eval harness (dataset schema, metrics), LLM tracing, hybrid search (Postgres FTS + pgvector with RRF) with chunking, and a read-only MCP server.

### 14. Public-release readiness
- Secrets or personal data in the working tree or git history (report locations, redacted), license, `.gitignore` coverage, hardcoded personal paths, README and setup accuracy (follow the setup steps statically and note anything that would fail on a clean machine), `.env.example` completeness, commit history cleanliness.

## Invariants to verify with code evidence

I1. Only accepted suggestions write to the vault (find every other writer, such as synergy bridge notes and settings).
I2. No outbound LLM traffic when `GEMINI_API_KEY` is unset.
I3. Embeddings are computed only locally.
I4. `suggestions.md` never affects project hashes or triggers reconciliation loops.
I5. Writeback is idempotent: one callout per accepted suggestion, even after a crash or retry.
I6. Re-ingesting the same canonical URL never creates duplicate evaluations or suggestions.
I7. All compared distances come from the same embedding model.

## Severity rubric

- **Critical:** vault corruption or data loss, remote exploitation from a web page, secret exfiltration, code execution.
- **High:** reliable integrity or privacy violation, or injection that changes vault content.
- **Medium:** correctness or reliability defect with a realistic trigger.
- **Low:** minor defect or hardening gap.
- **Informational:** observations and design notes.

## Finding format

ID · Title · Severity (with justification) · Confidence (Confirmed / Likely / Needs manual verification) · Area · Location(s) with line numbers · Evidence (short excerpt) · Realistic scenario (who, how, impact) · Recommended fix · Regression test.

## Deliverable (`docs/audit/AUDIT_REPORT.md`)

1. Coverage report: files reviewed, files not reviewed, commands run, what could not be assessed.
2. Executive summary with the top 5 risks.
3. Documentation-vs-implementation drift table.
4. **Dead code and legacy inventory** (table: item, location, classification, evidence, removal risk, suggested commit grouping).
5. Findings, prioritized (merge duplicates; cap at about 30).
6. Negative results: areas reviewed where no issue was found, with the files checked.
7. Missing tests, prioritized.
8. Manual verification plan using only `demo_vault` and a throwaway database (safe payloads for SSRF, CSRF, injection, writeback crash).
9. Product and usability assessment, separate from the engineering findings.
10. AI-engineering readiness gaps and proposed designs.
11. **Roadmap alignment:** for each phase in `02-roadmap.md`, what the code already provides, what is missing, and any acceptance criterion you would change.
12. **Story material:** a factual list of notable discoveries (surprising bugs, abandoned features, design decisions that held up or did not), each with file evidence. Facts only; no metrics you have not measured, no spin.
13. Open questions.

Do not make changes. Wait for the owner's review before any implementation.
