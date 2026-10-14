# Loom — Architecture & Technical Reference

> **Audience:** engineers and LLM reviewers who need to understand, audit or extend Loom.
> **State described:** git `master` @ `855e4f6` ("centralize config, shared AI provider, clean linting and types").
> **Verified on this snapshot:** `tsc --noEmit` clean, `eslint .` clean, 9/9 unit tests pass
> (`parser`, `dummy`, `youtube_ingest`). Integration tests need Docker + Ollama and were **not** run.
> Everything not covered by that is derived from reading the code; section 14 lists known problems.

---

## 1. What Loom is

Loom is a **local-first** assistant for people who write in Obsidian. The user:

1. keeps writing projects as folders of Markdown notes in an Obsidian vault (`Projects/<name>/…`);
2. pastes URLs (web articles, YouTube videos) into a small web UI;
3. Loom summarises each URL, embeds it, and checks it against every active project;
4. when a link is relevant, Loom proposes a **concrete action** ("cite this in Act 2", "counter-argument…");
5. the user accepts or discards each proposal in the UI. **Only accepted suggestions are written back to Obsidian**, as a callout in `<project>/suggestions.md`.

Design principles visible in the code:

- Obsidian is the source of truth for project content; Postgres holds derived state (snapshots, embeddings, verdicts).
- The AI never writes into the vault without an explicit user action.
- Embeddings are always local (Ollama `bge-m3`). The LLM for summaries/evaluations is Gemini when an API key is set, otherwise (or on any Gemini error) local Ollama.
- User-facing text (UI, prompts, callouts, LLM output) is **Spanish**. Code, identifiers and developer docs are English.

---

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js `>= 22`, TypeScript 5 (strict), CommonJS via `tsx` | No `"type": "module"`; `server.ts` uses `__dirname` and `require.main === module`. |
| Package manager | pnpm | `pnpm-workspace.yaml` lists `apps/*`, `packages/*`, which don't exist (leftover). |
| HTTP | Fastify 5 + `fastify-type-provider-zod` + `@fastify/static` | Zod schemas validate input and serialise output. |
| DB | PostgreSQL 16 + `pgvector` (docker image `pgvector/pgvector:pg16`) | Drizzle ORM 0.45, SQL migrations in `drizzle/`. |
| Queue | `pg-boss` 12 (in the same Postgres, schema `pgboss`) | Queues: `ingest_url`, `evaluate_content`, `sync_suggestions`. |
| Embeddings | Ollama `bge-m3` (1024-d) via `@langchain/ollama` | Configurable by `EMBED_MODEL`. Column is hard-coded `vector(1024)`. |
| LLM | Gemini (`@google/genai`) if `GEMINI_API_KEY`; else/fallback `qwen2.5:7b-instruct` via `ChatOllama` | Structured output validated by Zod. |
| Scraping | `jsdom` + `@mozilla/readability`; `youtube-transcript` + YouTube oEmbed | |
| File watching | `chokidar` 5 | |
| Frontend | Vanilla JS (ES module), HTML, CSS; no build step | Served from `web/`. |
| Tests | Vitest 1, Testcontainers (Postgres), live Ollama for some | See section 12. |

---

## 3. Repository layout

```
loom/
├─ src/
│  ├─ config.ts                 Zod-validated env + PROJECT_DIR_NAMES
│  ├─ ai/OllamaProvider.ts      Embeddings + structured LLM calls (Gemini→Ollama fallback); sharedAiProvider
│  ├─ api/
│  │  ├─ server.ts              Fastify app, error handler, startServer/stopServer, graceful shutdown
│  │  └─ routes/                ingest, contents, projects, suggestions, settings, system
│  ├─ db/                       index (pool+drizzle), schema, migrate, reset, seed, repositories
│  ├─ evaluator/index.ts        Vector pre-filter + LLM evaluation + backlog evaluation
│  ├─ queue/index.ts            pg-boss instance + queue creation
│  ├─ vault/                    config, hash, parser, reconciler, watcher, updater (writeback)
│  └─ workers/                  ingestionWorker, evaluationWorker, vaultWorker
├─ web/                         index.html, app.js (~1.3k lines), styles.css
├─ scripts/                     run_server, seed_demo, reconcile_and_reevaluate
├─ tests/                       11 test files + fixtures/golden-dataset-template.json
├─ drizzle/                     0000_dark_shard.sql, 0001_mighty_hannibal_king.sql, meta/
├─ docs/                        this file, ADRs, per-phase reports, code-review.md
├─ demo_vault/                  Sample Obsidian vault (Projects/Agentes_Autonomos)
├─ spikes/                      Early experiments (ollama, onnx); excluded from tsc/eslint
├─ start.bat / reset_db.bat     Windows launchers (Docker + migrate + Ollama checks)
└─ docker-compose.yml           Postgres+pgvector only
```

---

## 4. Runtime architecture

```mermaid
flowchart LR
  subgraph Client
    UI["Web UI<br/>(web/app.js)"]
  end
  subgraph Loom["Loom process (single Node process)"]
    API["Fastify API<br/>+ static files"]
    W1["ingestionWorker<br/>queue: ingest_url"]
    W2["evaluationWorker<br/>queue: evaluate_content"]
    W3["vaultWorker<br/>queue: sync_suggestions"]
    WATCH["Vault watcher<br/>(chokidar)"]
    REC["Reconciler"]
    AI["sharedAiProvider"]
  end
  PG[("PostgreSQL + pgvector<br/>public schema + pgboss schema")]
  OL["Ollama<br/>bge-m3, qwen2.5:7b"]
  GM["Gemini API<br/>(optional)"]
  OBS[["Obsidian vault<br/>Projects/ or Proyectos/"]]
  WEB[("Web / YouTube")]

  UI -->|HTTP| API
  API --> PG
  API -->|boss.send| PG
  PG -->|pg-boss| W1 & W2 & W3
  W1 -->|fetch| WEB
  W1 & W2 & REC --> AI
  AI -->|embeddings, fallback chat| OL
  AI -->|summaries / evaluations| GM
  OBS -->|fs events| WATCH --> REC --> PG
  REC -->|enqueue backlog| PG
  API -->|accept → append suggestions.md| OBS
  W3 -->|recovery writeback| OBS
```

Everything runs in **one process** (`scripts/run_server.ts` → `startServer()`): HTTP server, the three pg-boss workers and the vault watcher share the same event loop and the same Postgres pool. There is no auth; by default the server binds to `127.0.0.1`.

### Startup sequence (`startServer`)
1. `startQueue()`: `boss.start()` then `createQueue` for the three queues.
2. Register the three workers.
3. If `VAULT_PATH` (env or `.env`; `run_server.ts` falls back to `./demo_vault`) → `startVaultWatcher(path)` (**not awaited**: runs `bootReconcile`, then starts chokidar). Errors are logged.
4. `server.listen({ host: env.HOST, port: env.PORT })`.
5. Registers `SIGINT`/`SIGTERM` → `stopServer()`: stop watcher, `boss.stop()`, `server.close()`, `pool.end()`, then `process.exit(0)`.

---

## 5. Configuration

`src/config.ts` parses `process.env` with Zod at import time (invalid values throw at startup) after `dotenv.config()`.

| Variable | Default | Used for |
|---|---|---|
| `NODE_ENV` | `development` | `test` disables Fastify logger. |
| `HOST` | `127.0.0.1` | Bind address. Previously `0.0.0.0`. |
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://loom:loompassword@localhost:5432/loomdb` | Drizzle pool, pg-boss, drizzle-kit. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL. |
| `EMBED_MODEL` | `bge-m3` | Embedding model; also stored in `contents.embedding_model`. |
| `CHAT_MODEL` | `gemini-3.1-flash-lite` | **Gemini** model name (despite the generic name). The Ollama chat model is hard-coded `qwen2.5:7b-instruct`. |
| `GEMINI_API_KEY` | – | Enables the Gemini path. |
| `VAULT_PATH` | – | Obsidian vault root. Mutated at runtime by `POST /api/settings/vault`. |

Read **outside** the schema (direct `process.env`): `GEMINI_MODEL` (overrides `CHAT_MODEL`), `LOG_LEVEL` (default `warn`), `VITEST` (suppresses `.env` writes), `VAULT_PATH` at runtime (`vault/config.ts`, `suggestions.ts`, workers).

`persistVaultPath` rewrites the `VAULT_PATH=` line in `./.env` (skipped under tests).

---

## 6. Data model

```mermaid
erDiagram
  contents ||--o{ evaluations : "evaluated"
  projects ||--o{ project_snapshots : "versions"
  project_snapshots ||--o{ evaluations : "against"
  evaluations ||--o{ action_suggestions : "produces"
  projects ||--o{ action_suggestions : "belongs"
  contents ||--o{ action_suggestions : "source"
  action_suggestions ||--o{ llm_telemetry : "optional"
```

Source: `src/db/schema.ts`. All PKs are `uuid` (`gen_random_uuid()`); timestamps are `timestamp` **without** time zone.

| Table | Key columns | Notes |
|---|---|---|
| `contents` | `uri` UNIQUE (canonical), `title`, `channel_or_domain`, `raw_text`, `summary`, `embedding vector(1024)`, `embedding_model`, `consumption_seq` (default 1), `ingest_status` enum, `ingest_status_reason`, `consumed_at`, `created_at` | HNSW cosine index on `embedding`; btree on `consumed_at`. `source_type`, `is_raw_purged` are never written. |
| `projects` | `folder_path` UNIQUE (relative to vault, e.g. `Projects/Foo`), `title`, `current_hash`, `is_active` | `updated_at` is set manually in code (no DB trigger). |
| `project_snapshots` | `project_id` FK cascade, `tree_hash`, `thesis_text`, `notes_content`, `note_titles jsonb<string[]>`, `embedding vector(1024)`, `captured_at` | Immutable history. HNSW index + btree `(project_id, captured_at)`. Evaluation always uses the **latest** snapshot. |
| `evaluations` | `content_id`, `project_snapshot_id`, `verdict` enum, `confidence_score` real, `triage_reasoning`, `consumption_seq` | UNIQUE `(content_id, project_snapshot_id, consumption_seq)` = idempotency key. `verdict` is nullable in the schema. |
| `action_suggestions` | `evaluation_id`, `project_id`, `content_id`, `action_type` enum, `observation`, `suggested_action`, `status` enum, `user_feedback`, `written_to_vault`, `resolved_at`, `target_file` (always `'unknown'` for LLM suggestions) | Partial btree index on `status` where `pending`. `custom_type_label`, `target_section`, `source_reference` only set by `seed_demo`. |
| `llm_telemetry` | `component` enum (`summary|thesis|triage|action`), `model_name`, `latency_ms`, `is_success`, FK ids (set null) | **Only** `triage` rows are written, on success, with model + latency. Token/cost columns are unused. |

Enums: `ingest_status` = pending, extracting, summarizing, embedding, ready, failed · `verdict` = irrelevant, tentative, actionable · `action_type` = counter_argument, unblocker, evidence_citation, narrative_bridge, other · `suggestion_status` = pending, accepted, discarded.

Migrations: `0000_dark_shard.sql` creates everything; `0001_mighty_hannibal_king.sql` adds `project_snapshots.notes_content`. `pgvector` extension is created by `db:migrate`/`db:reset` before migrating. `drizzle.config.ts` uses `schemaFilter: ['public']` so Drizzle ignores the `pgboss` schema.

---

## 7. The Obsidian side (`src/vault/`)

### 7.1 Vault layout expected
```
<VAULT_PATH>/
  Projects/   (or Proyectos/)        ← PROJECT_DIR_NAMES
    <ProjectName>/
      project.md            ← preferred thesis source
      any-note.md           ← other notes, all included
      suggestions.md        ← written by Loom, ignored when reading
```
Only **direct child directories** of `Projects/`/`Proyectos/` are projects. Only `*.md` files **directly inside** a project folder are read; subfolders, attachments and other extensions are ignored (by the reconciler *and* the hash).

### 7.2 Parser (`parser.ts`)
`parseMarkdownFile(path)` → `{ hasProjectTag, title, thesis, rawContent } | null`.

- `hasProjectTag` = inline `#project` (regex `(^|\s)#project(?![\w/-])`, so not `#projects` / URL fragments) **or** frontmatter `tags:`/`tag:` containing `project` (scalar, `[a, b]`, or block list).
- Frontmatter is stripped only when anchored at file start (`^---\r?\n…\r?\n---`).
- Fenced code blocks are removed before title/thesis extraction.
- `title` = first `# H1` outside code, else filename without `.md`.
- `thesis` = remaining text with header lines (`^#+\s+…`) and the `#project` tag removed, truncated to **4000 chars**.
- Unreadable files log a warning and return `null`.

### 7.3 Hash (`hash.ts`)
`getDirectoryHash(projectDir)` = SHA-256 over, for each top-level `*.md` file (excluding `suggestions.md`, sorted by name): `"filename:<name>:"` + SHA-256 of the file (streamed). Returns `''` if the folder is missing or has no eligible file. Renames change the hash; non-Markdown changes do not.

### 7.4 Reconciler (`reconciler.ts`)
`reconcileProject(projectPath, vaultPath, force=false)`:

1. In-process lock (`Set` of resolved paths). If already reconciling that project, **skip** (does not queue).
2. Compute hash; `''` → return. Compute path relative to vault; reject `..`.
3. If not `force` and the stored `current_hash` equals the new hash **and** the latest snapshot has a non-null embedding → return (up to date).
4. Parse all eligible notes (`project.md` first, then alphabetical):
   - `title`: `project.md` H1; else the last note tagged `#project`; else folder name.
   - `thesisText`: `project.md` thesis; else tagged note thesis; else first 500 chars of the concatenated notes; else a Spanish placeholder.
   - `notesContent`: `### Nota: <title>\n<thesis>\n\n` for **every** note with a thesis (including `project.md`). Not capped at snapshot time.
   - `noteTitles`: titles of all parsed notes.
5. Embedding text = `thesisText + "\n\n" + notesContent`, truncated to **6000 chars**, embedded with `bge-m3`.
6. **If embedding fails or is empty → return without persisting anything** (hash is not stored, so the next event/boot/rescan retries).
7. In one DB transaction: update-or-insert `projects` (sets `current_hash`, `title`, `is_active = true`) and insert a new `project_snapshots` row.
8. Outside the transaction: `enqueueProjectBacklogEvaluations(projectId)` (errors logged, not fatal).

`bootReconcile(vault, force)` iterates `Projects/` and `Proyectos/` sequentially. `reconcileAllProjects(vault, force)` runs `bootReconcile`, then for every project row in DB checks the folder exists: missing & active → `is_active=false`; present & inactive → `is_active=true` and enqueue backlog evaluations. It returns `{id,title,folderPath,isActive,existsOnDisk}[]`.

### 7.5 Watcher (`watcher.ts`)
- Watches `<vault>/Projects` and `<vault>/Proyectos` with chokidar (`ignoreInitial: true`).
- `ignored` is a function evaluated **relative to the vault root**: any dot-segment (`.obsidian`, `.trash`) and any `suggestions.md` are ignored (so a dot-folder *above* the vault no longer breaks it).
- `add|change|unlink` of a `.md` file → debounce **3 s per project** → `reconcileProject`.
- `unlinkDir` of `Projects/<name>` → set `is_active=false` (dynamic imports of db/schema inside the handler).
- `error` events are logged.
- `startVaultWatcher(path, runInitialReconcile = true)`: stops any previous watcher, optionally runs `bootReconcile`, then starts watching. `POST /api/settings/vault` passes `false` and runs `reconcileAllProjects` itself.

### 7.6 Writeback (`updater.ts`)
Policy: **only `accepted` suggestions touch the vault**.

- `formatAcceptedCallout(sug)` renders (Spanish labels):
  ```markdown

  > [!tip] Sugerencia Aceptada: CITA DE EVIDENCIA (14/10/2026)
  > **Acción:** …
  > **Observación:** …
  > **Fuente:** [Title](https://…)
  > **Feedback:** …            (only if the user wrote feedback)
  ```
  Every line of multi-line fields is prefixed with `> `; `[`/`]` in titles are escaped; `(`/`)` in URLs are percent-encoded. The date uses `toLocaleDateString()` (server locale).
- `writeAcceptedSuggestionToVault(id, vaultPath)`: **atomic claim** (`UPDATE … SET written_to_vault = true WHERE id=? AND status='accepted' AND written_to_vault=false RETURNING`), then append to `<vault>/<folder_path>/suggestions.md` (mkdir -p). If the append throws, the flag is reverted and the error rethrown.
- `syncProjectSuggestions(projectId, vaultPath)` (used by `sync_suggestions` worker): reads all accepted-unwritten suggestions of a project, appends them in one write, then flags each. **Not atomic** (see section 14).

---

## 8. Ingestion pipeline

```mermaid
sequenceDiagram
  participant UI
  participant API as POST /api/ingest
  participant PG as Postgres
  participant Q as pg-boss ingest_url
  participant W as ingestionWorker
  participant AI as AI provider
  UI->>API: { url }
  API->>API: validate http(s) → canonicalizeUrl
  API->>PG: INSERT contents … ON CONFLICT(uri) DO UPDATE (status=pending, consumption_seq+1)
  API->>Q: send {contentId,url} (singletonKey=contentId, retryLimit=2)
  API-->>UI: 202 (new) / 200 (re-queued)
  Q->>W: job
  W->>PG: status=extracting
  alt YouTube
    W->>W: oEmbed (title/author) + transcript (≤50k chars)
  else web page
    W->>W: fetch (15s timeout, 5MB cap, content-type check) → JSDOM+Readability (≤50k chars)
  end
  W->>PG: raw_text,title,channel; status=summarizing
  W->>AI: summarise (Spanish) → {summary}
  W->>PG: summary; status=embedding
  W->>AI: embed(summary)
  W->>PG: embedding, embedding_model; status=ready
  W->>Q: send evaluate_content {contentId} (singletonKey=eval:<id>, retryLimit=2)
```

Details:

- **URL canonicalisation** (`canonicalizeUrl`): drop fragment; remove `utm_source|medium|campaign|term|content`, `fbclid`, `gclid`, `ref`; map `youtu.be/<id>`, `youtube.com|m.youtube.com/watch?v=`, `/shorts/`, `/embed/`, `/live/` to `https://www.youtube.com/watch?v=<id>`; strip trailing slash on non-root paths. Query-param order is not normalised. `canonicalizeYouTubeUrl` is an alias kept for compatibility.
- **`isNew`** in the route is heuristic: `|consumed_at − created_at| < 1000 ms`.
- **Web fetch**: header `User-Agent: Mozilla/5.0 (compatible; LoomBot/1.0; …)`, accepts `text/html`, `application/xhtml+xml`, `text/plain`; rejects other content types; rejects `content-length` or actual body over 5 MB; body always decoded as UTF-8.
- **Title** = `<title> - <byline>` when a byline exists and isn't already in the title. `channel_or_domain` = byline or hostname without `www.`.
- **Summary**: `summarySchema = { summary: string }`; system prompt (Spanish) asks for a concise summary in Spanish regardless of source language; the user message is the raw text (≤50k chars).
- **Error handling**: on any error the row is set to `failed` with `ingest_status_reason = error.message`. The error is **rethrown** (so pg-boss retries) unless the message matches a non-retryable regex (`Failed to fetch URL: 400|401|403|404|410|422`, no subtitles, unsupported content type, size limits, invalid URL, Readability failure). A retry sets the status back to `extracting`.
- Not blocked: private/loopback hosts (only the scheme is restricted), so the worker can still fetch internal URLs.

---

## 9. Evaluation pipeline

`evaluateContentMatch(contentId, targetProjectId?)` (`src/evaluator/index.ts`). Triggered by the `evaluate_content` queue: after ingestion (no target) or for backlog (with target).

**Step 1 — vector pre-filter (SQL).**
```sql
WITH latest_snapshots AS (
  SELECT DISTINCT ON (project_id) id, project_id, thesis_text, notes_content, embedding, captured_at
  FROM project_snapshots ORDER BY project_id, captured_at DESC)
SELECT ls.id, ls.project_id, ls.thesis_text, ls.notes_content
FROM latest_snapshots ls JOIN projects p ON p.id = ls.project_id
WHERE p.is_active AND [p.id = :target] AND ls.embedding IS NOT NULL
  AND ls.embedding <=> :contentEmbedding::vector < 0.6          -- cosine distance
ORDER BY ls.embedding <=> :contentEmbedding::vector
```
No top-K: every active project under the 0.6 threshold is evaluated. If the content has no embedding or summary the job returns silently.

**Step 2 — one LLM call per matching project.** For each row:

1. Idempotency check on `(content_id, snapshot_id, consumption_seq)`; skip if present.
2. System prompt (Spanish, constant): rules for `actionable` / `tentative` / `irrelevant`, "never suggest discarding", and the score bands (0–0.3 irrelevant, 0.4–0.6 tentative, 0.7–1.0 actionable).
3. User message: `<PROJECT_CONTEXT>` (thesis + notes ≤ **15,000 chars**) and `<ARTICLE_SUMMARY>` (≤ **10,000 chars**), so untrusted text is not in the system role.
4. Output schema (`unifiedEvaluationSchema`): `verdict`, `confidenceScore` ∈ [0,1], `triageReasoning` (Spanish), `action: { actionType, observation, suggestedAction } | null`.
5. Insert `evaluations`. A unique violation (`23505`) is treated as "already evaluated"; other errors are rethrown into the per-project `catch` (logged, loop continues).
6. If `actionable` and `action` present: a keyword filter (`startsWith('descartar')`, contains `descartar el artículo` / `no incluir`, or `other` + observation contains `no aporta`) downgrades the verdict to `irrelevant`, appends `[Motivo de descarte]` to the reasoning and skips. Otherwise insert `action_suggestions` (`status='pending'`, `target_file='unknown'`).
7. Insert `llm_telemetry` (`component='triage'`, `model_name = provider.lastUsedModel`, `latency_ms`). Failures here are swallowed. (The downgrade path `continue`s before this step, so it writes no telemetry.)

**Backlog (Option A).** `findBacklogUnevaluatedContents(projectId, limit=100)` selects `ready` contents with an embedding within 0.6 of the project's latest embedded snapshot and **no evaluation for any snapshot of that project**; `enqueueProjectBacklogEvaluations` sends `evaluate_content {contentId, targetProjectId}` for each. Called after each successful reconcile and when a project is re-activated.

### AI provider (`OllamaProvider.ts`)
- `getEmbedding(text)`: `OllamaEmbeddings.embedQuery`, `maxRetries: 3`; errors logged and rethrown.
- `evaluateContent(system, user, zodSchema)`:
  1. If a Gemini key exists: `generateContent({ model, contents: user, config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(schema) − $schema, temperature: 0.1 }})`; strip optional ``` fences; `JSON.parse`; `schema.parse`; on success `lastUsedModel = "gemini:<model>"`.
  2. On **any** Gemini error (network, quota, invalid schema, validation) → warn and fall back to `ChatOllama.withStructuredOutput(schema)` (`qwen2.5:7b-instruct`, `numCtx: 16384`, `temperature 0.1`, `maxRetries 3`); `lastUsedModel = "ollama:<model>"`.
- `sharedAiProvider` is a module-level singleton used by the reconciler, evaluator and ingestion worker. `lastUsedModel` is **mutable shared state**.
- Exports: `OllamaProvider` (class), `AiProvider` (alias), `sharedAiProvider`.

---

## 10. Suggestion lifecycle & triage semantics

```mermaid
stateDiagram-v2
  [*] --> pending: evaluator (actionable)
  pending --> accepted: PATCH accepted
  pending --> discarded: PATCH discarded
  accepted --> [*]: callout appended to suggestions.md
  note right of pending
    tentative / irrelevant evaluations are NOT rows in
    action_suggestions; the API exposes them as "virtual"
    suggestions whose id is the evaluation id.
  end note
```

`GET /api/suggestions?status=` maps UI tabs to data:

| status | Source rows |
|---|---|
| `pending` / `accepted` | `action_suggestions` with that status |
| `tentative` | `evaluations` with `verdict='tentative'` |
| `discarded` | `action_suggestions` discarded **∪** `evaluations` with `verdict='irrelevant'` |
| `active` (default) | `action_suggestions` pending **∪** tentative evaluations |

`active` and `discarded` are one SQL `UNION ALL … ORDER BY createdAt DESC LIMIT/OFFSET` (with a matching count query).

`PATCH /api/suggestions/:id` `{status: 'accepted'|'discarded', userFeedback?}`:

- **Id is an `action_suggestions` row:** `pending` → atomic transition (`WHERE status='pending'`); same-status repeat → 200 no-op; different status → **409**. On `accepted` → `writeAcceptedSuggestionToVault`; on failure it logs and enqueues `sync_suggestions {projectId}` (`singletonKey sync:<projectId>`, retryLimit 2).
- **Id is an evaluation id (no suggestion row):**
  - `discarded` → sets `evaluations.verdict = 'irrelevant'` (**overwrites the LLM verdict**).
  - `accepted` → finds or creates an `action_suggestions` row (`actionType 'narrative_bridge'`, `targetFile 'ideas.md'`, observation "Afinidad temática aceptada por el usuario", `suggestedAction = triage_reasoning`), status `accepted`, then writes it to the vault. Idempotent by `evaluation_id`. **It does not change the evaluation verdict** (see section 14, item K1).

---

## 11. HTTP API

Base: `http://<HOST>:<PORT>`. Validation errors → `400 {error, message:'Validation failed', issues}`. Unhandled 5xx → `{error:'Internal Server Error', message:'An internal server error occurred'}`. Timestamps are ISO strings.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /health`, `GET /ping?echo=`, `GET /favicon.ico` | Liveness | |
| `POST /api/ingest` `{url}` | Queue a URL | `202` new, `200` re-queued (`consumption_seq+1`), `400` bad URL, `500`. |
| `GET /api/contents?status&limit(1-100,30)&offset` | Inbox feed, newest `consumed_at` first | Each item: counts (`evaluations`, `actionable`, `tentative`, `irrelevant`, `suggestions`), `evaluationsList` (per project verdicts), `hasSpatialAffinity`, `isEvaluating`. |
| `GET /api/contents/:id` | Detail | Adds `summary` and `evaluations[]`. `404`. |
| `GET /api/projects?isActive=true\|false` | Project list | Latest snapshot thesis + `noteTitles`; `counts {pending, accepted, discarded, tentative, active, total}`. Batched queries. |
| `GET /api/projects/:id` | Project detail | Adds `snapshotsCount`, `latestSnapshotAt`. `404`. |
| `GET /api/suggestions?projectId&status(active)&limit(1-100,50)&offset` | Triage feed | See section 10. |
| `GET /api/suggestions/:id` | Detail | Accepts suggestion ids and evaluation ids; includes `contentSummary`, `triageVerdict`. `404`. |
| `PATCH /api/suggestions/:id` | Accept / discard | `200`, `404`, `409`. `userFeedback` ≤ 1000 chars. |
| `GET /api/settings/vault` | Vault status | `vaultPath`, `isValid`, `hasProjectsDir`, `watcherActive`, projects with `existsOnDisk`, `suggestionsCount`. |
| `POST /api/settings/vault` `{vaultPath}` | Change vault | Validates directory (`400` otherwise) → persists to env + `.env` → restarts watcher (no initial reconcile) → `reconcileAllProjects` (**synchronous**, may be slow) → summary. |
| `POST /api/settings/vault/rescan` | Force re-scan | `reconcileAllProjects(path, force=true)`; re-embeds every project and creates new snapshots. |
| `GET /api/system/status` | Activity indicator | Counts active pg-boss jobs (`pgboss.job`) and contents in `extracting|summarizing|embedding`; returns a Spanish status message. |
| `GET /*` | Static UI | `web/index.html` etc. via `@fastify/static`. |

`isEvaluating` for a content = ingest in progress **or** a pg-boss `evaluate_content` job for that content in `created|active|retry`. `hasSpatialAffinity` = the content is within 0.6 of the **latest** snapshot of any active project (correlated subquery per row).

---

## 12. Web UI (`web/`)

Single page, three tabs (Spanish UI):

1. **Inbox** — URL form → `POST /api/ingest`; feed of contents with status chips (Pendiente, Extrayendo, Resumiendo, Indexando, Listo, Falló), filter by status, retry button for failures, detail modal (summary + per-project verdicts).
2. **Triage** — project sidebar ("Todos los Proyectos" + each project with badge of `active` count), status tabs (Activas, Pendientes, Tentativas, Aceptadas, Descartadas), suggestion cards with collapsible reasoning (lazy `GET /api/suggestions/:id`), optional feedback textarea, Accept/Discard buttons (optimistic count update, then reload from API).
3. **Settings** — vault path form, rescan button, status pill, table of detected projects with disk state.

Implementation notes:
- ES module (`<script type="module">`), global `state` object, `innerHTML` templating with `escapeHtml`; external links pass through `safeUrl` (only `http:`/`https:`).
- Polling: `/api/system/status` every 2.5 s (skipped while `document.hidden`, never overlapping); when processing ends it reloads contents, projects, suggestions. While any item is in flight, contents are polled every 3 s.
- Preserves open `<details>` and feedback drafts across refreshes (`openDetails`, `loadedReasonings`, `feedbackDrafts`, render signature).
- Fonts load from Google Fonts (external request).

---

## 13. Tooling, tests and operations

**Scripts (`package.json`)**: `dev` (tsx watch), `start`, `db:generate|migrate|reset|seed`, `test` (vitest run), `lint` (eslint, `.eslintrc.json`, `@typescript-eslint` 7), `typecheck` (`tsc --noEmit`, `module ESNext`, `moduleResolution bundler`, excludes `spikes`).

**Destructive scripts** — read before running: `db:reset` drops `public`, `drizzle`, `pgboss` schemas; `scripts/seed_demo.ts` deletes all rows of the main tables and rewrites `demo_vault/Projects/Agentes_Autonomos`; `scripts/reconcile_and_reevaluate.ts` deletes **all** evaluations and pending suggestions, forces a rescan and re-evaluates every ready content (sequentially).

**Windows launchers**: `start.bat` checks Node, creates `.env` from the example, starts Docker Desktop if needed, runs `docker compose up -d postgres`, waits for `pg_isready`, runs `db:migrate`, checks Ollama and the two models, opens the browser, runs `dev`. Its Node check message says v20+ while `engines` requires `>=22`.

**Tests (`tests/`)**

| File | Type | Needs |
|---|---|---|
| `dummy`, `parser` (5), `youtube_ingest` (3) | Unit | nothing |
| `db` (3) | Integration (schema, UNIQUE, KNN, HNSW `EXPLAIN` with 10k vectors) | Docker |
| `ollama` (2) | Integration | live Ollama with both models |
| `evaluation`, `ingestion` | Integration | Docker (+ Ollama for real LLM) |
| `phase6_lifecycle` (9), `phase7_ui` (9), `settings_vault` (6) | API integration (Fastify `inject`) | Docker |
| `full_e2e` (1) | Vault → ingest → evaluate → accept → writeback | Docker + Ollama |

Integration tests start a `pgvector/pgvector:pg16` Testcontainer, set `DATABASE_URL`, then dynamically import app modules (because `config.ts` reads env at import). There is no mock AI provider; no tests cover the new canonicalisation cases, callout formatting, hash scoping, or the fetch limits.

**Operational behaviour worth knowing**
- Ollama cold start can take 30–40 s per document (ADR/phase reports).
- Ingestion jobs run one at a time per worker; evaluation is sequential per content and per matching project.
- `docker-compose.yml` publishes Postgres on `5432` (all interfaces) with a static password.

---

## 14. Known issues and open questions

Ordered by importance. "Observed" = seen by reading the code; none was reproduced at runtime.

| # | Area | Issue |
|---|---|---|
| K1 | Suggestions | **Accepting a tentative item no longer changes the evaluation verdict.** The evaluation stays `tentative`, so it can keep appearing in the *Tentativas*/*Activas* tabs after being accepted, next to the new accepted suggestion. (Previously the code flipped it to `actionable`, which also destroyed the LLM verdict; the right fix is a separate `user_decision` column.) |
| K2 | Privacy | ADR 001 (A9) says the cloud LLM must never receive full user drafts. With `GEMINI_API_KEY` set, the evaluator sends the thesis plus up to 15,000 chars of **notes content**, and ingestion sends up to 50,000 chars of article text. |
| K3 | Reconciler | A reconcile skipped by the in-process lock is **dropped**, not queued. If notes change while a reconcile of the same project is running (embedding takes seconds), the final state can lag until the next event, boot or rescan. |
| K4 | Security | No authentication. The server is localhost-only by default, but `HOST` can expose it; any caller can change the vault path and write files in it. SSRF: only `http/https` is enforced; private/loopback targets are not blocked. Postgres is published with a static password. |
| K5 | Telemetry | `lastUsedModel` lives on a shared singleton; concurrent ingestion + evaluation can attribute the wrong model. Only `triage` is recorded; no tokens/cost; failures aren't recorded. |
| K6 | Writeback | `syncProjectSuggestions` appends then flags (read–append–update, not claimed atomically): concurrent runs can duplicate callouts. Callout date is server-locale dependent. |
| K7 | Ingestion | Non-retryable errors are detected by **message regex**; non-UTF-8 pages are mis-decoded; the summary prompt can exceed the Ollama context for 50k-char texts on the fallback path; YouTube transcripts may contain HTML entities. |
| K8 | Vault scope | Notes in sub-folders of a project are ignored entirely; `.md` extension match is case-sensitive; the embedding text duplicates `project.md` (it is both the thesis and a note in `notesContent`). |
| K9 | Data | Timestamps without time zone; no indexes on `action_suggestions(project_id|content_id|evaluation_id)`; `updated_at` not auto-updated; dead columns (`source_type`, `is_raw_purged`, `target_section`, `custom_type_label`, `source_reference`, `llm_telemetry` token/cost). |
| K10 | Config | `.env.example` is stale (see README for the current list); `CHAT_MODEL` really means "Gemini model"; Ollama model name is hard-coded; several variables are read straight from `process.env`. |
| K11 | Settings | `POST /api/settings/vault` blocks until all projects are embedded; `reconcileAllProjects` runs sequentially. |
| K12 | Tooling/tests | Most tests need Docker/Ollama and there is no mock provider; devDependencies still list `@huggingface/transformers`, `ollama`, `ts-node` (spikes only); `pnpm-workspace.yaml` points to non-existent dirs; `start.bat` says Node v20. |
| K13 | Evaluator | One LLM call per matching project is sequential and unbounded (no top-K); the discard keyword filter is Spanish-phrase based; threshold `0.6` is hard-coded in three places; evaluation only considers the latest snapshot. |

### Suggested review questions
1. Is the cosine threshold `0.6` for `bge-m3` over summary-vs-thesis embeddings reasonable, and should it be configurable or relative (top-K)?
2. Is embedding `thesis + all notes` (6000 chars) the right project representation, or should notes be embedded individually?
3. Does the fallback chain (Gemini → Ollama on any error) hide failures that should surface (quota, schema rejection)?
4. Does the accept/discard handling of "virtual" evaluation suggestions need its own table/state instead of mutating `evaluations`?
5. Are there race conditions between watcher debounce, boot reconcile, manual rescan and backlog enqueueing?
6. Is the ADR-001 contract (A4 gating, A5 NULL thesis, A8 idempotent marker, A9 cloud privacy) still intended? See `docs/adr/001-…` for current status.

---

## 15. Further reading

- `docs/adr/001-decisiones-arquitectura-a1-a10.md`, `002-modelo-embedding.md`, `003-endurecimiento-post-revision.md` (Spanish).
- `docs/code-review.md` — findings from the review and their current status.
- `docs/fase-0 … fase-7-report.md` — historical phase reports (Spanish), each with a post-review addendum.
