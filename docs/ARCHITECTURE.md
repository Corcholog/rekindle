# Rekindle — Architecture & Technical Reference

> **Audience:** Engineers, contributors, and LLM reviewers who need to understand, audit, or extend Rekindle.  
> **State described:** git `master` after Phase 2 (security and integrity fixes; see `docs/agent/02-roadmap.md`). Behaviors marked **Known issue** are documented as they are today and are not fixed yet.  
> **Verification:** run `pnpm typecheck`, `pnpm lint` and `pnpm test`; per-phase results are recorded in `docs/JOURNEY.md`.

---

## 1. What Rekindle Is

Rekindle is a **local-first, human-in-the-loop intelligence layer** that connects what you read on the web with what you write in your personal knowledge base (Obsidian).

The workflow centers on writer agency:
1. **Writing projects as folders in Obsidian**: You maintain projects as collections of Markdown notes under `Projects/<ProjectName>/` (or `Proyectos/<ProjectName>/`).
2. **Seamless link capture**: You ingest web articles, essays, and YouTube videos via the web UI or the **Manifest V3 Web Clipper extension** (which queues clippings locally when offline and auto-syncs on reconnect).
3. **Structured summarization & local embedding**: Rekindle extracts the readable article text or video transcript, synthesizes a structured summary (in the notes language, Spanish by default), and calculates a 1024-dimensional dense vector embedding locally via Ollama (`bge-m3`).
4. **Hierarchical semantic matching**: Rekindle compares the incoming content against both whole-project embeddings and granular note-level embeddings (`project_note_snapshots`) in PostgreSQL using `pgvector` cosine distance.
5. **Constructive triage & action proposal**: When cosine distance indicates semantic affinity (< 0.6), Rekindle prompts an LLM (Gemini with automatic local Ollama fallback) to formulate a concrete, constructive action targeting a specific note in your project (e.g., *"Citar evidencia en research/combat.md"*, *"Contraargumento para Acto 2"*).
6. **Explicit writeback**: Pending and tentative suggestions **never alter your vault**. Only suggestions you explicitly click **Aceptar** on are appended to your vault as native Obsidian callouts (`> [!tip]`) inside `<project>/suggestions.md`. Synergy bridge notes and research briefs are only written when you click **Guardar en Obsidian** (§11).
7. **Living knowledge synchronization**:
   - **Vector-gated staleness detection**: Detects when notes evolve in Obsidian and flags older suggestions as stale (`isStale`).
   - **Tentative promotions**: Automatically re-evaluates past tentative contents when project drafts expand or move closer.
   - **Cross-project thematic synergies**: Discovers conceptual bridges between separate projects via note-to-note cosine distance and generates bridge notes.
   - **Archive & Vault Research Partner ("Consultor")**: Evaluates your entire saved library and all active Obsidian notes simultaneously to diagnose research questions, assess project viability, and provide cited references (`[C1]`, `[N1]`).

### Core Design Principles
- **Obsidian is the primary source of truth**: The filesystem holds your creative writing. PostgreSQL holds derived vector index state, immutable snapshots, and triage history.
- **Zero unapproved mutations** (invariant I1): AI cannot write or edit notes without your explicit action. Suggestions are written only after **Aceptar**; generated notes only after **Guardar en Obsidian**, as new files that never overwrite anything. Model text is sanitized before it reaches the vault (`src/vault/sanitize.ts`).
- **Privacy & local-first foundation**: Vector embeddings are strictly calculated on-device via Ollama. Without `GEMINI_API_KEY`, every LLM call (summaries, evaluations, re-evaluations, Consultor, synergies, synthesis) runs locally with Ollama. Non-LLM outbound traffic remains: fetching the pages and YouTube metadata/transcripts you ingest. The UI's fonts are bundled.
- **Two languages, chosen by measurement**: the interface, generated text and vault callouts come in Spanish or English (section 18). Prompt instructions stay Spanish because the evals measured them that way; summaries follow the language of the notes they are compared with. Source code, API messages, developer documentation and commits are in **English**.

---

## 2. Tech Stack

| Domain | Technology | Details / Rationale |
|---|---|---|
| **Runtime** | Node.js `>= 22`, TypeScript 5 (strict), CommonJS via `tsx` | Robust async I/O, native fetch timeout, strict type safety. |
| **Package Manager** | pnpm | Fast, deterministic dependency tree. |
| **Web Server & API** | Fastify 5 + `fastify-type-provider-zod` + `@fastify/static` | High-performance HTTP server with compile-time and runtime Zod validation. |
| **Database & Vector Index** | PostgreSQL 16 + `pgvector` (`pgvector/pgvector:pg16`) | Relational integrity with HNSW vector cosine indexing (`vector(1024)`). |
| **ORM & Migrations** | Drizzle ORM 0.45 (`drizzle-kit`) | Type-safe SQL builder with explicit migration files in `drizzle/`. |
| **Job Queue** | `pg-boss` 12 | Background worker queues (`ingest_url`, `evaluate_content`, `sync_suggestions`) running on Postgres. |
| **Embeddings** | Ollama `bge-m3` (1024-d) via `@langchain/ollama` | High-accuracy multilingual dense embeddings executed 100% locally. |
| **LLM Provider** | Gemini (`@google/genai`) with fallback to local `ChatOllama` (`qwen2.5:7b-instruct`) | Structured output with Zod schemas. Seamless fallback if Gemini quota, key, or network fails. |
| **Filesystem Watcher** | `chokidar` 5.x | Real-time debounced watching of Obsidian project directories. |
| **Browser Extension** | Manifest V3 (Chrome / Chromium / Edge / Brave) | Background service worker, offline queueing in `chrome.storage.local`, auto-sync alarms. |
| **Web Frontend** | React 19, TypeScript, Vite, Tailwind CSS v4, Radix (shadcn/ui style) | Literata and Hanken Grotesk bundled with the app; light and dark themes |

---

## 3. Repository Layout

```
rekindle/
├─ extension/                         Manifest V3 Web Clipper browser extension
│  ├─ manifest.json                   Extension manifest, permissions & host declarations
│  ├─ background.js                   Service worker with offline queue & auto-sync engine
│  ├─ popup.html / popup.js           Clipper popup UI with status badges & manual controls
│  └─ icons/                          Extension action icons (16px, 48px, 128px)
├─ src/
│  ├─ config.ts                       Zod-validated environment config (loopback-only HOST) & thresholds
│  ├─ ai/
│  │  ├─ aiProvider.ts                AI facade: structured completions via the provider chain, local embeddings
│  │  ├─ chain.ts                     Ordered provider chain (LLM_PROVIDERS), one retry on malformed output
│  │  ├─ types.ts                     ChatProvider interface, error kinds, JSON parsing/validation
│  │  ├─ pricing.ts                   List prices for cost estimates: cached input, off-peak hours (shared with evals)
│  │  └─ providers/                   deepseek.ts, gemini.ts, ollama.ts
│  ├─ api/
│  │  ├─ server.ts                    Fastify app setup, error handler, lifecycle hooks, boot writeback recovery
│  │  ├─ requestGuard.ts              Host/Origin guard against DNS rebinding and cross-site writes
│  │  └─ routes/
│  │     ├─ contents.ts               GET /api/contents (Inbox feed & content detail)
│  │     ├─ ingest.ts                 POST /api/ingest (Ingestion queue trigger)
│  │     ├─ library.ts                Consultor (/api/library/consult)
│  │     ├─ projects.ts               Projects list, /synergies, /explore, /synthesize
│  │     ├─ settings.ts               Vault path validation, persistence, rescan
│  │     ├─ suggestions.ts            Triage feed, /reevaluate, /reevaluate-stale, PATCH
│  │     └─ system.ts                 GET /api/system/status & /health activity indicators
│  ├─ db/
│  │  ├─ index.ts                     Postgres pool & Drizzle ORM client
│  │  ├─ schema.ts                    Tables, enums, pgvector custom type, HNSW indexes
│  │  └─ migrate.ts / reset.ts        Migration executor & destructive database reset
│  ├─ evaluator/
│  │  └─ index.ts                     Hierarchical 2-step evaluation & backlog promotion engine
│  ├─ queue/
│  │  └─ index.ts                     pg-boss client initialization & queue definitions
│  ├─ vault/
│  │  ├─ config.ts                    Vault path resolver & Linux udisksctl auto-mounter
│  │  ├─ hash.ts                      Deterministic recursive project directory SHA-256 hash
│  │  ├─ parser.ts                    Markdown parser (#project tags, frontmatter, H1 title)
│  │  ├─ reconciler.ts                Project reconciler & note-level embedding generator
│  │  ├─ updater.ts                   Crash-safe writeback to <project>/suggestions.md (markers + recovery)
│  │  ├─ sanitize.ts                  Neutralizes active markdown in model text before vault writes
│  │  ├─ generatedNotes.ts            Explicitly saved synergy notes and briefs (never overwrite)
│  │  └─ watcher.ts                   Chokidar live filesystem watcher with debounce
│  ├─ observability/
│  │  ├─ logger.ts                    Redacting pino logger (no text, URLs or error messages)
│  │  ├─ llmTelemetry.ts              One llm_telemetry row per provider attempt
│  │  ├─ pipeline.ts                  Trace IDs and pipeline_events (stage timing, retrieval)
│  │  ├─ report.ts / trace.ts         telemetry:report / telemetry:trace / prune
│  │  └─ cli.ts                       pnpm telemetry:* entry point
│  ├─ net/
│  │  └─ safeFetch.ts                 Public-internet-only page fetch (DNS-checked IPs, redirects, 5 MB cap)
│  └─ workers/
│     ├─ ingestionWorker.ts           Job processor for 'ingest_url' queue
│     ├─ evaluationWorker.ts          Job processor for 'evaluate_content' queue
│     └─ vaultWorker.ts               Job processor for 'sync_suggestions' recovery queue
├─ web/                               React + TypeScript UI (Vite), built into web/dist and served via Fastify static
│  ├─ src/views/                      Reading, Suggestions, Consultant, Settings
│  ├─ src/components/                 Suggestion card, ember meter, dialogs, ui/ primitives
│  ├─ src/i18n/dict.ts                Spanish and English strings
│  └─ src/styles.css                  Tailwind v4 and the light/dark design tokens
├─ scripts/
│  └─ run_server.ts                   Server entrypoint for development & production
├─ drizzle/                           SQL migrations (never edited once applied)
├─ tests/                             Automated test suites (unit + integration + e2e)
├─ demo_vault/                        Sample Obsidian vault with project structures
├─ docs/                              Architecture reference, ADRs, agent workflow (docs/agent), build log (JOURNEY.md)
├─ start.bat / start.sh               One-click launch scripts (Linux & Windows)
├─ reset_db.bat / reset_db.sh         Database reset scripts
└─ docker-compose.yml                 PostgreSQL 16 + pgvector container definition
```

---

## 4. Runtime Architecture

```mermaid
flowchart TD
  subgraph Clients["Clients"]
    UI["Web UI<br/>(web/src, React)"]
    EXT["Web Clipper Extension<br/>(Manifest V3)"]
    OFFLINE[("Offline Storage<br/>chrome.storage.local")]
    EXT <-->|Queue / Sync| OFFLINE
  end

  subgraph Server["Rekindle Server (Single Node.js Process)"]
    API["Fastify API Router<br/>(Zod Validated Routes)"]
    WATCH["Vault Watcher<br/>(chokidar, debounced 3s)"]
    REC["Project Reconciler<br/>(Hierarchical Parser & Lock)"]
    
    subgraph Queues["pg-boss Queues"]
      Q_INGEST["queue: ingest_url"]
      Q_EVAL["queue: evaluate_content"]
      Q_SYNC["queue: sync_suggestions"]
    end

    subgraph Workers["Background Workers"]
      W1["ingestionWorker<br/>Readability / YouTube"]
      W2["evaluationWorker<br/>Hierarchical Evaluator"]
      W3["vaultWorker<br/>Writeback Sync"]
    end

    AI["sharedAiProvider<br/>(Ollama / Gemini Fallback)"]
  end

  subgraph Storage["Storage & External Systems"]
    PG[("PostgreSQL 16 + pgvector<br/>(HNSW Indexes, Tables, pgboss)")]
    VAULT[["Obsidian Vault<br/>(Projects/<Folder>/**/*.md)"]]
    OL[("Local Ollama<br/>bge-m3 (1024-d)<br/>qwen2.5:7b-instruct")]
    GM["Google Gemini API<br/>(Optional Cloud LLM)"]
    WEB[("Internet / Web / YouTube")]
  end

  UI -->|HTTP REST| API
  EXT -->|HTTP POST /api/ingest| API
  API -->|Enqueue Jobs| PG
  PG -->|pg-boss Dispatch| Q_INGEST & Q_EVAL & Q_SYNC
  Q_INGEST --> W1
  Q_EVAL --> W2
  Q_SYNC --> W3

  W1 -->|Fetch & Extract| WEB
  W1 --> AI
  W2 --> AI
  REC --> AI

  AI -->|Embeddings (bge-m3)| OL
  AI -->|Structured JSON| GM
  GM -.->|Fallback on error| OL

  VAULT -->|File Events| WATCH --> REC
  REC -->|Snapshots & Note Embeddings| PG
  REC -->|Backlog & Promotions| Q_EVAL

  API -->|Accept Suggestion| VAULT
  API -->|Explicit save: synergy note / research brief| VAULT
  W3 -->|Recovery Writeback| VAULT
```

### Server Startup Lifecycle (`src/api/server.ts` → `startServer`)
1. **Initialize Task Queue**: `boss.start()` connects to PostgreSQL and creates the `pgboss` schema and queues.
2. **Register Background Workers**: Workers for `ingest_url`, `evaluate_content`, and `sync_suggestions` attach to their respective queues.
3. **Mount Filesystem Watcher**: If a valid `VAULT_PATH` is configured:
   - Validates the directory (and invokes Linux `udisksctl` auto-mount if residing on an unmounted removable media drive).
   - Starts `bootReconcile` in the background.
   - Begins live monitoring with `chokidar` over `Projects/` and `Proyectos/`.
4. **Bind HTTP Server**: Fastify listens on `HOST`:`PORT` (defaults to `127.0.0.1:3000`).
5. **Graceful Shutdown**: Catches `SIGINT`/`SIGTERM` to close the watcher, drain queues, close the HTTP listener, terminate database connection pools, and exit cleanly.

---

## 5. Configuration & Constants

Rekindle reads configuration through `src/config.ts`, which validates `process.env` against a strict Zod schema at startup:

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | `enum` | `'development'` | Application environment (`development`, `production`, `test`). |
| `HOST` | `string` | `'127.0.0.1'` | Network bind address. Must be `127.0.0.1`, `localhost` or `::1`; startup fails otherwise (the API has no authentication). |
| `PORT` | `number` | `3000` | HTTP listen port. |
| `DATABASE_URL` | `string` | `postgres://rekindle:rekindlepassword@localhost:5432/rekindledb` | PostgreSQL connection URI. |
| `OLLAMA_URL` | `string` | `http://127.0.0.1:11434` | Ollama service endpoint. |
| `EMBED_MODEL` | `string` | `'bge-m3'` | Dense embedding model name (must produce 1024-dimensional vectors). |
| `CHAT_MODEL` | `string` | `'gemini-3.1-flash-lite'` | Gemini model identifier. The Ollama chat model is `qwen2.5:7b-instruct`. |
| `LLM_PROVIDERS` | `string` | `'deepseek,gemini,ollama'` | Provider order: `deepseek`, `gemini`, `ollama`. Providers needing a key are skipped without one. Malformed output (empty, invalid JSON, schema mismatch) is retried once on the same provider; transport errors go straight to the next. |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | `string?` | – / `'deepseek-flash'` | DeepSeek through its OpenAI-compatible API, JSON mode with the schema in the prompt and thinking requested off (it is on by default at DeepSeek). |
| `GEMINI_MODEL` | `string?` | *optional* | Overrides `CHAT_MODEL` (read directly from `process.env`). |
| `GEMINI_API_KEY` | `string?` | *optional* | Google AI Studio API key. If omitted, every LLM call runs locally on Ollama. |
| `VAULT_PATH` | `string?` | *optional* | Absolute or relative path to the root of the Obsidian vault. `pnpm start/dev` default to the demo vault of the notes language (`./demo_vault` or `./demo_vault_en`); the UI can rewrite it in `.env`. |
| `LANGUAGE` | `es \| en` | `es` (`.env.example` ships `en`) | Preset for the interface default and the two below. |
| `OUTPUT_LANGUAGE` | `es \| en` | `LANGUAGE` | Language of reasoning, actions, Consultor answers, synergies, briefs and callouts. Read at call time; editable in Settings. |
| `NOTES_LANGUAGE` | `es \| en` | `LANGUAGE` | Language of the owner's notes. Summaries are written in it, since they are embedded and compared with the notes. Editable in Settings. |
| `LOG_LEVEL` | `string?` | `'info'` (`'silent'` under `NODE_ENV=test`) | Level of the server's structured logger, shared with Fastify (read directly from `process.env`). |
| `LOG_FORMAT` | `string?` | `'pretty'` (`'json'` under `NODE_ENV=production`) | `pretty` prints one readable line per record; `json` prints raw pino JSON lines. |

### Semantic Engine Constants (`src/config.ts`)
- `PROJECT_DIR_NAMES = ['Projects', 'Proyectos']`: Recognised top-level vault project directories.
- `VECTOR_DISTANCE_THRESHOLD = 0.6`: Cosine distance cutoff for initial vector pre-filtering in evaluations.
- `TOP_K_PROJECTS_LIMIT = 3`: Maximum number of candidate projects the LLM evaluates per content (the closest ones). On the owner-labeled eval set, 3 keeps 86% of the relevant pairs at 45% fewer LLM calls than 10 (`evals/SWEEP.md`).
- `STALE_DRIFT_THRESHOLD = 0.04`: Minimum cosine drift between evaluated snapshot and current snapshot to trigger staleness flagging (`isStale`).
- `PROMOTION_DELTA_THRESHOLD = 0.08`: Cosine similarity improvement needed to re-evaluate and promote a tentative content after project updates.
- `NOTE_PROMOTION_DISTANCE_THRESHOLD = 0.50`: Absolute note affinity cutoff triggering tentative promotion when a new note is added.
- The note-level promotion delta (`0.04`) is an inline literal in `src/evaluator/index.ts`, not a named constant.
- None of these values has been calibrated against labeled data yet (Phase 3 eval harness).

---

## 6. Data Model

```mermaid
erDiagram
  contents ||--o{ evaluations : "evaluated for"
  projects ||--o{ project_snapshots : "has history"
  projects ||--o{ project_note_snapshots : "owns notes"
  project_snapshots ||--o{ project_note_snapshots : "contains"
  project_snapshots ||--o{ evaluations : "evaluated against"
  evaluations ||--o{ action_suggestions : "yields"
  projects ||--o{ action_suggestions : "targets"
  contents ||--o{ action_suggestions : "references"
  action_suggestions ||--o{ llm_telemetry : "telemetry"
  contents ||--o{ pipeline_events : "traced by"
  pipeline_events ||--o{ evaluations : "retrieval selected"

  contents {
    uuid id PK
    text uri UK
    text title
    text channel_or_domain
    text raw_text
    text summary
    vector_1024 embedding
    text embedding_model
    integer consumption_seq
    ingest_status ingest_status
    uuid trace_id
    timestamp consumed_at
  }

  projects {
    uuid id PK
    text folder_path UK
    text title
    varchar_64 current_hash
    boolean is_active
    timestamp updated_at
  }

  project_snapshots {
    uuid id PK
    uuid project_id FK
    varchar_64 tree_hash
    text thesis_text
    text notes_content
    jsonb note_titles
    vector_1024 embedding
    text embedding_model
    timestamp captured_at
  }

  project_note_snapshots {
    uuid id PK
    uuid project_snapshot_id FK
    uuid project_id FK
    text note_path
    text note_title
    text content_snippet
    vector_1024 embedding
    text embedding_model
    timestamp created_at
  }

  evaluations {
    uuid id PK
    uuid content_id FK
    uuid project_snapshot_id FK
    verdict verdict
    real confidence_score
    text triage_reasoning
    integer consumption_seq
    uuid trace_id
    uuid retrieval_event_id FK
    timestamp evaluated_at
  }

  action_suggestions {
    uuid id PK
    uuid evaluation_id FK
    uuid project_id FK
    uuid content_id FK
    action_type action_type
    text target_file
    text observation
    text suggested_action
    suggestion_status status
    text user_feedback
    discard_reason discard_reason
    boolean written_to_vault
    timestamp resolved_at
  }

  llm_telemetry {
    uuid id PK
    telemetry_component component
    uuid trace_id
    uuid content_id FK
    uuid snapshot_id FK
    uuid suggestion_id FK
    text provider
    text model_name
    integer attempt_no
    boolean is_success
    text error_kind
    boolean is_fallback
    integer latency_ms
    integer prompt_tokens
    integer completion_tokens
    real cost_usd
    varchar_16 prompt_hash
  }

  pipeline_events {
    uuid id PK
    uuid trace_id
    pipeline_stage stage
    uuid content_id FK
    uuid snapshot_id FK
    integer duration_ms
    boolean ok
    text error_kind
    integer attempt
    jsonb attrs
  }
```

### Table Specifications & Index Strategy
1. **`contents`**:
   - Stores canonical web and video content with LLM summaries and 1024-d embeddings.
   - Indexes: HNSW cosine index `contents_embedding_idx` using `vector_cosine_ops`; btree on `consumed_at`.
   - Note: pgvector uses HNSW only for `ORDER BY distance LIMIT k` queries. The evaluator, backlog and synergy queries filter on a distance threshold or cross-join, so they are not expected to use these indexes (not yet measured with `EXPLAIN` on realistic data).
   - Idempotency: Unique constraint on canonical `uri`.
2. **`projects`**:
   - Master list of Obsidian projects discovered on disk.
   - `folder_path` is unique relative to the vault root (e.g. `Projects/Video_Ensayo`).
3. **`project_snapshots`**:
   - Immutable historical record of project state. A new snapshot is created whenever project contents change.
   - Contains collective project embedding (`embedding`) calculated from the combined thesis and notes.
   - Indexes: HNSW cosine index `project_snapshots_embedding_idx`; btree on `(project_id, captured_at)`.
4. **`project_note_snapshots` (Hierarchical Note Embeddings)**:
   - Stores granular 1024-d embeddings for **individual Markdown notes** inside project directories and subdirectories.
   - Enables fine-grained targeting: Rekindle matches content directly to specific notes (`research/combat.md`, `ideas.md`) instead of diluting them into an aggregate project blob.
   - Indexes: HNSW cosine index `project_note_snapshots_embedding_idx`; foreign key indexes on `project_snapshot_id` and `project_id`.
5. **`evaluations`**:
   - The verdict (`actionable`, `tentative`, `irrelevant`) and reasoning of the LLM for a given `(content_id, project_snapshot_id)`.
   - Unique composite index on `(content_id, project_snapshot_id, consumption_seq)` prevents redundant LLM evaluations.
6. **`action_suggestions`**:
   - Concrete proposed actions generated when an evaluation is `actionable`.
   - `target_file` is the note the LLM proposed (falling back to the closest-affinity note, then `ideas.md`). It is shown in the UI and used for staleness detection; it is **not** used for writing: accepted callouts always go to `<project>/suggestions.md`.
   - Partial btree index `action_suggestions_status_partial_idx` on `status` where `status = 'pending'`.
7. **`llm_telemetry`**:
   - One row per provider attempt of every LLM call that passes a call context (all six: `summary`, `triage`, `consult`, `synergy`, `synthesis`, `reevaluate`), failures included: provider, model, attempt number, error kind, fallback flag, rate-limit wait, latency, tokens, estimated cost (`src/ai/pricing.ts`), prompt and answer lengths and a 16-hex prompt hash. Never prompt or answer text. Indexed on `created_at` and `trace_id`. See section 16.
8. **`pipeline_events`**:
   - One row per pipeline stage of a trace (`fetch`, `extract`, `summarize`, `embed`, `ingest_job`, `retrieve`, `evaluate`, `evaluate_job`) with duration, outcome, error kind, pg-boss attempt and `attrs` (IDs, counts, lengths, distances). `evaluations.retrieval_event_id` points at the `retrieve` event that selected the project (set null if that event is pruned). Indexed on `created_at` and `trace_id`.

---

## 7. The Obsidian Integration (`src/vault/`)

### 7.1 Recursive Vault Layout & Project Recognition
Rekindle monitors two top-level directories: `Projects/` and `Proyectos/`.
- **Recursive note structure**: Projects are represented by directory folders (e.g. `Projects/SciFi_Novel/`). Notes can live at the root of the project or in nested subdirectories (e.g. `Projects/SciFi_Novel/worldbuilding/factions.md`).
- **No mandatory `project.md`**: Rekindle does not force a rigid `project.md` file. The project thesis and title are derived heuristically:
  1. If a note carries the `#project` tag (inline or frontmatter `tags: [project]`), its text is the thesis and its H1 title becomes the project title.
  2. Otherwise the project title is the folder name and the thesis is the first 800 characters of the concatenated notes.
- **Excluded patterns**: Hidden files/folders (`.obsidian/`, `.trash/`, `.git/`), attachments, Rekindle's own output file (`suggestions.md`) and notes Rekindle generated (frontmatter `rekindle_generated: true`, or `type: research_brief` / `cross_project_synergy` from earlier versions) are ignored during parsing and hashing, so generated text never feeds back into project context.

### 7.2 Parser (`parser.ts`)
- Strips YAML frontmatter anchored at file start.
- Strips fenced code blocks to prevent false-positive hashtag or title matches inside code snippets.
- Extracts the first Markdown `# H1` heading outside code blocks as the note title.
- Truncates extracted note thesis/snippet to 4,000 characters.

### 7.3 Hash Engine (`hash.ts`)
- Recursively traverses the project folder for all `.md` files (excluding `suggestions.md`).
- Sorts relative paths deterministically to ensure platform-independent stability.
- Computes SHA-256 by streaming file contents prefixed with `"filename:<relPath>:"`.
- Changing a note's filename or content immediately alters the directory hash.

### 7.4 Reconciler (`reconciler.ts`)
When file changes are detected:
1. **In-Process Locking & Queued Passes**: If a reconciliation is already active for a project, the reconciler records the request in `pendingProjectReconciliations` and automatically runs a follow-up pass upon completion, eliminating lock-drop race conditions.
2. **Change Verification**: Compares the new hash against `projects.current_hash`. If unchanged and the latest snapshot has a valid embedding, reconciliation terminates early.
3. **Hierarchical Snapshot Generation**:
   - Generates individual 1024-d embeddings for every parsed note and prepares `project_note_snapshots` records.
   - Generates an aggregate 1024-d embedding for the overall project.
   - In a single database transaction, updates `projects` and inserts `project_snapshots` + `project_note_snapshots`.
4. **Automatic Backlog & Promotion Enqueueing**:
   - Triggers `findBacklogUnevaluatedContents(projectId)` to find unevaluated library contents or tentative contents qualifying for promotion, queueing them for evaluation.

### 7.5 Watcher & Auto-Mounting (`watcher.ts` & `config.ts`)
- Chokidar monitors project directories with a 3-second per-project debounce timer.
- **Linux Removable Drive Support**: `ensureDriveMountedIfLinuxMedia` detects paths under `/run/media/...` and automatically issues `udisksctl mount` if the partition is currently unmounted.

### 7.6 Writeback (`updater.ts`)
Policy: **Only accepted suggestions write to the vault.**
- Callout format:
  ```markdown
  > [!tip] Sugerencia Aceptada: CITA DE EVIDENCIA (16/10/2026)
  > **Acción:** Integrar datos del artículo en la sección de antecedentes.
  > **Observación:** El informe aporta cifras que validan la hipótesis principal.
  > **Fuente:** [Título del Artículo](https://example.com/article)
  > **Feedback:** Considerar también el contraargumento de la página 4.
  ```
- Each callout ends with a hidden Obsidian comment, `%% rekindle:<suggestion id> %%`.
- The write runs in a transaction that locks the suggestion row (`SELECT … FOR UPDATE`): read `suggestions.md`; append the callout only if its marker is absent; then set `written_to_vault = true`. A crash after the append leaves the marker, so the retry only sets the flag (invariant I5).
- If the write fails, the flag stays `false` and a `sync_suggestions` job retries; every pending writeback is also retried when the server starts.
- The project folder must already exist inside the vault; Rekindle never creates it (this matters after switching vaults).
- Model text is passed through `sanitizeForVault()`: code fences, `![[embeds]]` and remote images, raw HTML, Templater tags, `%%` comments, forged `[!callouts]` and Dataview inline queries are neutralized; prose, links and `[[wikilinks]]` are kept.

---

## 8. Ingestion Pipeline & Web Clipper

### 8.1 Ingestion Pipeline Sequence
```
URL Ingest (UI / Extension)
  │
  ▼
URL Normalization (Strip UTM, fbclid, canonicalize YouTube variants)
  │
  ▼
DB Insert (new URL only; a known URL is not re-queued unless its previous ingest failed — invariant I6)
  │
  ▼
pg-boss 'ingest_url' job
  │
  ├───► YouTube: oEmbed metadata + youtube-transcript
  └───► Web Page: fetchPublicPage (every resolved IP and redirect hop must be public, 15s timeout,
         5MB streamed cap, content-type check) + Readability
  │
  ▼
LLM Summarization (Spanish summary schema, raw text capped at 50k chars; only the summary is embedded)
  │
  ▼
Local Embedding (Ollama bge-m3, 1024-d)
  │
  ▼
DB Update (contents: status='ready', embedding)
  │
  ▼
pg-boss 'evaluate_content' job
```

### 8.2 Web Clipper Extension (`extension/`)
Rekindle includes a full Manifest V3 browser extension for 1-click clipping from Chromium-based browsers:
- **Instant Clipping**: Action popup and context menu let users clip the active tab URL or highlighted text selection.
- **Offline Resilience**: If the Rekindle server is offline or unreachable, clippings are not lost; they are stored in `chrome.storage.local` with an amber badge indicator showing the queued count.
- **Background Auto-Sync**: The service worker (`extension/background.js`) flushes queued clippings to `POST /api/ingest` from a `chrome.alarms` timer (every minute while the queue is non-empty), on tab activation, on browser startup and right after enqueueing. The popup (`popup.js`) can also flush the queue directly. **Known issue:** both flush paths read and rewrite the same storage key without coordination, so a clip can be sent twice or dropped.
- The extension reaches Rekindle through its `host_permissions` (`localhost:3000`, `127.0.0.1:3000`), so the server sends no CORS headers. It is the only supported browser clipper.

---

## 9. Hierarchical Evaluation Pipeline

Evaluation is triggered by the `evaluate_content` queue (either for newly ingested content or during project backlog reconciliation).

### Step 1: Spatial Semantic Pre-filter (PostgreSQL pgvector)
Rekindle performs a combined vector search querying both project-level and note-level embeddings:
```sql
WITH latest_snapshots AS (
  SELECT DISTINCT ON (project_id) id, project_id, thesis_text, notes_content, embedding, captured_at
  FROM project_snapshots ORDER BY project_id, captured_at DESC
),
matching_notes AS (
  SELECT DISTINCT ON (pns.project_id)
    pns.project_id, pns.note_path, pns.note_title, pns.content_snippet,
    (pns.embedding <=> :contentEmbedding::vector) AS note_distance
  FROM project_note_snapshots pns
  JOIN latest_snapshots ls ON pns.project_snapshot_id = ls.id
  WHERE pns.embedding IS NOT NULL
    AND (pns.embedding <=> :contentEmbedding::vector) < 0.6
  ORDER BY pns.project_id, (pns.embedding <=> :contentEmbedding::vector) ASC
)
SELECT 
  ls.id AS snapshot_id, ls.project_id, ls.thesis_text, ls.notes_content,
  mn.note_path AS matched_note_path, mn.note_title AS matched_note_title, mn.content_snippet AS matched_note_snippet,
  COALESCE(mn.note_distance, (ls.embedding <=> :contentEmbedding::vector)) AS best_distance
FROM latest_snapshots ls
JOIN projects p ON ls.project_id = p.id
LEFT JOIN matching_notes mn ON ls.project_id = mn.project_id
WHERE p.is_active = true
  AND (mn.note_path IS NOT NULL OR (ls.embedding <=> :contentEmbedding::vector) < 0.6)
ORDER BY best_distance ASC
LIMIT 3; -- TOP_K_PROJECTS_LIMIT
```

### Step 2: Unified LLM Synthesis & Note Targeting
For each candidate project under the 0.6 cutoff:
1. **Focal Note Context Injection**: The evaluator injects the specific note with highest semantic affinity (`matchedNotePath`, `matchedNoteSnippet`) directly into `<PROJECT_CONTEXT>`, ensuring the LLM knows which specific file to target.
2. **Single Structured LLM Call**:
   ```ts
   const unifiedEvaluationSchema = z.object({
     verdict: z.enum(['actionable', 'tentative', 'irrelevant']),
     confidenceScore: z.number().min(0).max(1),
     triageReasoning: z.string(),
     action: z.object({
       actionType: z.enum(['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']),
       observation: z.string(),
       suggestedAction: z.string(),
       targetFile: z.string().nullish(),
     }).nullable(),
   });
   ```
3. **Target File Resolution** (`targetFile.ts`): the LLM's `targetFile` is kept only if it names one of the snapshot's notes (exact path, path plus `.md`, or a file name only one note has); anything else, including paths outside the project, falls back to `matchedNotePath`, then `ideas.md`. Re-evaluation refinements go through the same check.
4. **Anti-Discard Guardrail**: If an actionable verdict paradoxically recommends discarding the content, Rekindle automatically downgrades the verdict to `irrelevant` and appends the explanation to `triageReasoning`.
5. **Idempotency**: an evaluation is skipped if one exists for the same `(content_id, project_snapshot_id, consumption_seq)`; a concurrent duplicate hits the unique index and is skipped. An evaluation and its suggestion are written in one transaction, so an interrupted job leaves neither. Re-ingesting a known URL does not re-queue it or change `consumption_seq` (now always 1), so it never re-runs evaluation (invariant I6). Each evaluation has at most one suggestion (unique `action_suggestions.evaluation_id`). The pg-boss queues use the standard policy, where `singletonKey` does not de-duplicate, so duplicate jobs rely on this idempotency.
6. **Failure handling**: an LLM error for one project is recorded (a failed `evaluate` event, the failed LLM attempts, `failures` on the `evaluate_job` event), the other projects are still evaluated, and then the worker fails the job so pg-boss retries it (3 retries, backoff from 30 s). Projects already evaluated are skipped on retry. After the last retry the job stays failed and the pair waits for a backlog run; the UI does not show it, `telemetry:report` does.
7. **Embedding model**: only embeddings produced by the current `EMBED_MODEL` are compared; contents and snapshots from another model are skipped until re-embedded (invariant I7).

### Step 3: Backlog Re-evaluation & Tentative Promotions
When a project's notes change:
- `findBacklogUnevaluatedContents`: Evaluates ready contents that were never checked against the project.
- **Tentative Promotion Engine**: If a past evaluation was `tentative`, Rekindle automatically checks if:
  - The project moved closer to the content by at least `PROMOTION_DELTA_THRESHOLD` (`0.08`), OR
  - A new or updated note in the project has strong affinity (`< 0.50` distance).
  If so, the content is queued for re-evaluation, allowing tentative items to naturally promote to `actionable`.

---

## 10. Suggestion Lifecycle, Staleness & Triage Semantics

```mermaid
stateDiagram-v2
  [*] --> pending: Evaluator (actionable verdict)
  [*] --> tentative: Evaluator (tentative verdict)
  [*] --> irrelevant: Evaluator (irrelevant verdict)

  pending --> accepted: User clicks Aceptar (PATCH)
  pending --> discarded: User clicks Descartar (PATCH)
  pending --> reevaluated: User clicks Reevaluar (POST /reevaluate)

  tentative --> accepted: User promotes from Tentativas tab
  tentative --> discarded: User discards from Tentativas tab

  accepted --> [*]: Callout appended to suggestions.md
  discarded --> [*]: Excluded from vault writeback
```

### Vector-Gated Staleness Detection
As the user writes notes in Obsidian, previously generated suggestions may become out of date. Rekindle dynamically computes `isStale` and `driftScore` in SQL without requiring manual invalidation:
- **Snapshot Drift**: If the current snapshot embedding diverges from the snapshot at evaluation time by `>= STALE_DRIFT_THRESHOLD` (`0.04`).
- **Target Note Drift / Deletion**: If the specific note targeted by `targetFile` has drifted by `>= 0.04` or was deleted from the vault.
- Stale suggestions display a visual badge in the UI and provide a **Reevaluar** action.

### Context-Aware Re-evaluation (`POST /api/suggestions/:id/reevaluate`)
When re-evaluating a stale suggestion:
1. Rekindle loads the original suggestion, the content summary, and the **latest project snapshot** from the database (all notes concatenated, capped at 15,000 characters).
2. The LLM evaluates whether the suggestion should be:
   - `keep_or_refine`: Kept and updated with refined observations matching the new draft.
   - `already_addressed`: Auto-resolved because the writer already incorporated the ideas.
   - `obsolete`: Discarded because the draft moved in a completely different direction.

---

## 11. Synergies, Backlog Synthesis & Archive Consultant

### 11.1 Cross-Project Thematic Synergies (`/api/projects/synergies`)
Rekindle discovers hidden connections across separate projects by calculating the cosine distance between notes of different projects (`project_note_snapshots` where `pA.id != pB.id`):
- `GET /api/projects/synergies`: Returns high-affinity project pairs, closest matching notes, and semantic similarity scores.
- `POST /api/projects/synergies/explore`: Prompts the LLM to analyze the overlap between both projects and returns a bridge note (shared problems, mutual benefits, markdown). It does **not** write to the vault. If a bridge note already exists on disk, it is returned instead of calling the LLM (`forceRegenerate` skips that).
- `POST /api/projects/synergies/save` (the **Guardar en Obsidian** button): writes the note shown in the UI as `synergy_<A>_<B>.md` in project A's projects directory (`Projects/` or `Proyectos/`), sanitized and marked `rekindle_generated: true`. An existing file is never overwritten; a timestamped name is used instead.
- **Known issue:** the note-to-note comparison and the notes sent to the LLM are taken from all historical snapshots, not just the latest one, so deleted notes can still appear.

### 11.2 Project Backlog Synthesis (`/api/projects/:id/synthesize`)
Compiles the project's **accepted** suggestions and latest notes into a Research Brief via the LLM and returns it without writing anything. `POST /api/projects/:id/synthesis/save` (the **Guardar en Obsidian** button) writes it to the project folder as `research_brief.md`, or a timestamped name if that file exists. Saved briefs are sanitized, marked `rekindle_generated: true`, and excluded from the project's notes and embeddings.

### 11.3 Archive & Vault Research Partner ("Consultor" - `/api/library/consult`)
A dedicated research consultant that reasons over your entire intellectual repository:
- **Full-Catalog Direct Context**: Injects the catalog of all ready library items (`[C1]`, `[C2]`, ...) and all active Obsidian notes (`[N1]`, `[N2]`, ...) simultaneously.
- **Natural Language Dialogue**: Answers broad questions (e.g. *"¿Tenemos material sobre videojuegos narrativos?"*, *"¿Es viable armar un ensayo sobre atención y tecnología?"*).
- **Cited Outputs**: Generates a diagnosis with inline references (`[C1]`, `[N1]`), an optional project viability assessment, and itemized connection cards (`whyItConnects`). The cards are resolved against the catalog and unknown references are dropped; inline references inside the diagnosis text are not verified.
- **Scale:** the whole catalog is sent in a single prompt (no retrieval step), so large libraries can exceed the local model's 16k-token context window.

---

## 12. Complete HTTP API Reference

Base URL: `http://<HOST>:<PORT>` (default `http://127.0.0.1:3000`).

### 1. Ingestion & Contents
- `POST /api/ingest`
  - Body: `{ url: string, title?: string, selection?: string }` (public `http(s)` URLs only)
  - Returns: `202 { message, contentId, status: 'pending' }` for a new URL. For a known URL, `200` with the same shape: `status: 'pending'` if a failed ingest is retried, otherwise its current status (nothing is re-queued).
- `GET /api/contents`
  - Query: `status?`, `limit?` (default 30), `offset?` (default 0)
  - Returns: List of contents with evaluation counts, verdicts, spatial affinity flag, and active processing status.
- `GET /api/contents/:id`
  - Returns: Full content metadata, clean text preview, summary, and evaluations list.

### 2. Archive & Library Consultant
- `POST /api/library/consult`
  - Body: `{ query: string }`
  - Returns: `{ query, diagnosis, projectViability, matchedContents: [...], matchedNotes: [...] }`

### 3. Projects & Synergies
- `GET /api/projects`
  - Query: `isActive?` (boolean)
  - Returns: Projects list with latest snapshot thesis, note titles, and suggestion counters (`pending`, `accepted`, `discarded`, `tentative`, `active`).
- `GET /api/projects/synergies`
  - Query: `minSimilarity?` (default 20), `limit?` (default 15)
  - Returns: Cross-project thematic pairs with closest note matches and similarity scores.
- `POST /api/projects/synergies/explore`
  - Body: `{ projectAId, projectBId, forceRegenerate? }`
  - Returns: `{ success, bridgeTitle, overview, sharedProblems, mutualBenefits, markdownContent, filePath, writtenToVault, isCached }`. Writes nothing; `filePath` is set only when an existing note was read from disk.
- `POST /api/projects/synergies/save`
  - Body: `{ projectAId, projectBId, bridgeTitle, overview, sharedProblems, mutualBenefits, markdownContent }`
  - Returns: `{ success, filePath }` (vault-relative path of the new note).
- `POST /api/projects/:id/synthesize`
  - No body.
  - Returns: `{ success, filePath: null, title, executiveSummary, markdownContent, suggestedNextSteps, acceptedCount, writtenToVault: false }`; `400` when the project has no accepted suggestions.
- `POST /api/projects/:id/synthesis/save`
  - Body: `{ title, executiveSummary, markdownContent, suggestedNextSteps, acceptedCount? }`
  - Returns: `{ success, filePath }`.

### 4. Suggestions & Triage
- `GET /api/suggestions`
  - Query: `projectId?`, `status?` (`active` | `pending` | `tentative` | `accepted` | `discarded`), `limit?`, `offset?`
  - Returns: Paginated suggestions with `targetFile`, `isStale`, `driftScore`, and triage reasoning.
- `GET /api/suggestions/:id`
  - Returns: Suggestion detail with content summary, observation, and confidence score.
- `PATCH /api/suggestions/:id`
  - Body: `{ status: 'accepted' | 'discarded', userFeedback?, discardReason? }` (`discardReason`: `unrelated | obvious | wrong_note | poorly_worded | other`, only with `discarded`)
  - Returns: Updated suggestion. On `accepted`, atomically appends callout to `suggestions.md`.
- `POST /api/suggestions/:id/reevaluate`
  - No body. Only pending suggestions can be re-evaluated.
  - Returns: Context-aware re-evaluation verdict (`keep_or_refine`, `already_addressed`, `obsolete`).
- `POST /api/projects/:id/reevaluate-stale`
  - Re-evaluates all stale pending suggestions in a project in batch.

### 5. Settings & System Status
- `GET /api/settings/vault`: Current vault path, access validation, active project list, disk status.
- `POST /api/settings/vault`: `{ vaultPath: string }` - Validates, updates `.env`, restarts watcher, and runs vault reconciliation.
- `POST /api/settings/vault/rescan`: Force rescan and re-embedding of all projects in the vault.
- `GET /api/system/status`: Real-time health indicator showing active pg-boss jobs and worker states.
- `GET /health`: Liveness probe.

---

## 13. Web UI Architecture (`web/`)

A React 19 + TypeScript single-page app, built by Vite into `web/dist` and served by the API server from the same origin (the request guard stays strict: no dev server on another port). `pnpm dev` runs `vite build --watch` next to the server.

- **Build** (`web/vite.config.ts`): one classic IIFE bundle with fixed names (`assets/app.js`, CSS injected by it) so the tests can load the real build in jsdom. Fonts (Literata for text to read, Hanken Grotesk for the interface) are bundled from `@fontsource`, so the UI contacts nothing outside the machine.
- **Styling**: Tailwind CSS v4 with the design tokens as CSS variables (`web/src/styles.css`): a cool ash-grey "paper" light theme and a warm "coal" dark theme, switched by a `.dark` class from the system setting or the choice in Settings. Ember is reserved for heat (dormant projects, rekindling suggestions, the one primary action of a view). Every text token reaches WCAG AA on every background (`tests/ui_contrast.test.ts`).
- **Components**: Radix primitives in the shadcn/ui style, copied into `web/src/components/ui/` (Dialog, Tabs) plus native selects; icons from lucide-react; toasts from sonner.
- **Views** (`web/src/views/`), addressed by the URL hash (`#reading`, `#suggestions`, `#consultant`, `#settings`):
  1. **Reading** (*Consumo*): clip a URL, first-run guidance pointing at the demo articles, the reading feed with per-project verdicts, and the content detail dialog.
  2. **Suggestions** (*Sugerencias*): project sidebar sorted by `sortProjects` (dormant projects with something to review first) with an ember meter per project, status tabs, collapsible synergies, and `SuggestionCard`: the action first in Literata, a "rekindles a project idle for N days" badge, reasoning folded, accept / discard with a reason / re-evaluate.
  3. **Consultant** (*Consultor*): question, example chips, the answer with `[C1]`/`[N1]` references turned into jump links by splitting the text (never markup), and the cited cards.
  4. **Settings** (*Configuración*): vault path, projects with their last edit, languages, theme.
- **Data**: a typed client (`web/src/lib/api.ts`); views reload when background work finishes (the status poll bumps a refresh key).
- **Safety (threat T9)**: React escapes all text; no component uses `dangerouslySetInnerHTML` or `innerHTML` (`tests/ui_i18n.test.ts`); only `http(s)` URLs become an `href` (`safeHref`). `tests/ui_xss.test.ts` runs the built bundle against the real API with hostile titles, notes and model output, in both languages and both themes.
- **Languages**: `web/src/i18n/dict.ts` holds the Spanish and English dictionaries; `t()` for text and `tRich()` for text with React nodes in placeholders (code, emphasis). The interface language is stored per browser and defaults to the server's `LANGUAGE`; API errors are shown through their `code`.

---

## 14. Tooling, Tests and Operations

### Development & Operational Commands
```bash
pnpm dev                   # Watch-build the web UI and restart the server on changes
pnpm build:web             # Build the React UI into web/dist (served by the server)
pnpm start                 # Start production server
pnpm typecheck             # Run tsc --noEmit
pnpm lint                  # Run ESLint over codebase
pnpm test                  # Run Vitest test suites
pnpm test:coverage         # Same, with v8 line/branch coverage for src/
pnpm run db:generate       # Generate a migration after editing src/db/schema.ts
pnpm run db:migrate        # Apply Drizzle migrations to PostgreSQL
pnpm run db:reset          # Drop schemas and re-migrate (destructive)
pnpm telemetry:report      # Latency, failure/fallback rates and cost over a period (--since 7d)
pnpm telemetry:trace <id>  # One suggestion or content back through retrieval and ingestion
pnpm telemetry:prune --older-than 90d   # Delete old telemetry rows and pipeline events
pnpm preflight             # Install check: Node, .env, Postgres, migrations, Ollama models, vault, providers (start.sh runs it)
pnpm usertest:stats        # Counts only for user-test sessions: acceptance rate, discard reasons, time to first suggestion
```

### Automated Test Suites (`tests/`)
- **Unit Tests (Offline, Zero-dependency)**:
  - `tests/parser.test.ts`: Markdown parsing, frontmatter extraction, inline `#project` hashtags.
  - `tests/youtube_ingest.test.ts`: YouTube URL canonicalization, Shorts/embed mappings.
  - `tests/extension_offline.test.ts`: Extension manifest and offline-queue source checks.
  - `tests/request_guard.test.ts`, `tests/safe_fetch.test.ts`: Host/Origin guard and SSRF protection (local HTTP servers).
  - `tests/vault_sanitize.test.ts`, `tests/generated_notes.test.ts`, `tests/env_writer.test.ts`: vault-write sanitization, generated notes, `.env` writer.
  - `tests/invariants.test.ts`: invariants I2, I3 and I4 with mocked LLM SDKs.
  - `tests/logger_redaction.test.ts`: the structured logger censors text-like fields and error messages.
- **Integration Tests (Require Docker / Testcontainers; no Ollama or API key: `tests/helpers/fakeAi.ts` provides deterministic embeddings and scripted answers through `AiProvider.setOverrides()`)**:
  - `tests/db.test.ts`: Database schema validation, pgvector HNSW cosine KNN operations.
  - `tests/evaluation.test.ts` & `tests/ingestion.test.ts`: Worker pipeline tests.
  - `tests/phase6_lifecycle.test.ts` & `tests/phase7_ui.test.ts`: API route tests via Fastify `inject`.
  - `tests/settings_vault.test.ts`: Vault path configuration and reconciliation tests.
  - `tests/vector_gated_staleness.test.ts`: Staleness detection and re-evaluation.
  - `tests/writeback_recovery.test.ts`, `tests/tentative_accept_race.test.ts`: crash-safe, single-callout writeback (I5).
  - `tests/reingest_idempotency.test.ts`, `tests/embedding_model.test.ts`: invariants I6 and I7.
  - `tests/error_responses.test.ts`: 500 responses do not leak internal errors.
  - `tests/ollama.test.ts`: Live Ollama embedding and structured-output checks. Opt-in (`REKINDLE_LIVE_TESTS=1`).
  - `tests/failure_evaluation.test.ts`, `tests/failure_jobs.test.ts`, `tests/failure_reconcile.test.ts`, `tests/failure_injection.test.ts`, `tests/failure_target_path.test.ts`: the audit's failure scenarios (invalid output and timeouts, every provider failing, duplicate and interrupted jobs, a note edited mid-reconcile, prompt injection, target paths outside the project); scenario 5 is in `writeback_recovery`, scenario 7 in `safe_fetch`. Mapping in `docs/THREAT_MODEL.md`.
  - `tests/ui_xss.test.ts`: the real web UI in jsdom against the real API with hostile titles, notes and model output.
  - `tests/full_e2e.test.ts`: Full end-to-end flow from URL ingestion to Obsidian writeback. Opt-in live check (`REKINDLE_LIVE_TESTS=1`); skipped otherwise.
  - `tests/pipeline_trace.test.ts`: Phase 4 acceptance. The real ingest route, queue and workers with stubbed models and fetch: one trace links a suggestion to its content and retrieval event, and a sentinel planted in notes, articles, model output, error messages and URLs never reaches the logs or the telemetry tables.
  - `tests/first_suggestion.test.ts`: the README path offline: demo vault indexed, article ingested and evaluated, one pending suggestion, one callout after accepting, no suggestion for a control article.
  - `tests/doctor.test.ts`, `tests/demo_vault.test.ts`, `tests/discard_reason.test.ts`, `tests/usertest_stats.test.ts`: the preflight checks and probes, the shape of the demo vault, discard reasons, and the user-test counts (no text in the output).
  - `tests/observability_schema.test.ts`, `tests/llm_telemetry.test.ts`, `tests/telemetry_report.test.ts`: migration 0006, per-attempt telemetry rows, and the report math on hand-built rows.
- Under Vitest the default `DATABASE_URL` and `OLLAMA_URL` point at closed ports and the cloud keys are blank (`vitest.config.ts`): a test must stub its Testcontainers URL before importing anything that reaches `src/db`, and no test reaches a model unless `REKINDLE_LIVE_TESTS=1`.
- **CI** (`.github/workflows/ci.yml`): on every push and pull request, frozen-lockfile install, typecheck, lint, the full suite and `pnpm audit --prod --audit-level high`, on Node 22 with Actions pinned to commit SHAs.

---

## 15. Evaluation harness (`evals/`)

`pnpm eval run <dataset> --config <file>` measures retrieval and triage quality. It starts a throwaway Postgres, reconciles the dataset's vault with the real reconciler, summarizes and embeds each labeled article, runs `retrieveCandidates` and `evaluateContentMatch`, and compares the verdicts with the owner's `labels.yaml`. Embeddings, summaries and LLM answers are cached per dataset, so a recorded dataset replays offline and deterministically (`--replay`). The runner swaps in its record/replay layer through `AiProvider.setOverrides()`; production code paths are otherwise unchanged. See `evals/README.md` for the workflow, the metrics and the privacy rules. Real notes and labels live only in the git-ignored `evals/private/`. Each run also writes `<dataset>/runs/<config>.json` (summaries, retrieval distances and every model's verdict, reasoning and suggested action); `pnpm eval:review <dataset>` serves a local page (127.0.0.1, same Host/Origin guard as the API) that shows those answers next to the owner's labels, saves corrections to `labels.yaml` and re-scores live with the same `scoreRun` function the runner uses.

## 16. Observability (`src/observability/`)

Model behavior is measured from IDs, counts, lengths, hashes and durations; note text, article text, prompts, model output and URLs are never logged or stored in telemetry.

- **Trace ID.** `POST /api/ingest` starts a trace for each ingestion it enqueues and stores it on the content. It travels in the `ingest_url` and `evaluate_content` job payloads, so one trace covers fetch → extract → summarize → embed → retrieve → triage → suggestion. Backlog evaluations (from the reconciler), direct evaluations and re-evaluations start their own trace (`origin` in the `evaluate_job` event).
- **Stages** (`pipeline.ts`): `recordStage` / `timeStage` write `pipeline_events`. The `retrieve` event keeps the threshold, the limit, how many projects were within the threshold before the limit, and each candidate's rank, project, snapshot, note snapshot, level and distance. Each `evaluate` event (one per candidate) records verdict, confidence and the evaluation and suggestion IDs; failures record an error kind such as `llm_chain` or `ProviderError`'s kind.
- **LLM calls** (`llmTelemetry.ts`): `AiProvider.evaluateContent(system, user, schema, options, ctx)` writes one `llm_telemetry` row per attempt when a context is given, including the attempts of a call that threw. Rows written for a triage call are linked to the suggestion it produced. Telemetry write errors are logged and never fail the pipeline.
- **Logs** (`logger.ts`): one pino logger for the workers, evaluator, vault code and Fastify (per-request logging off: request URLs can carry search text). Keys such as `text`, `prompt`, `summary`, `url`, `title`, `notePath`, `message` and `stack` are censored at any depth; errors keep only `{type, kind, status, code}`. Folder and note paths appear as a 10-hex `pathKey` hash.
- **Commands** (`report.ts`, `trace.ts`, `cli.ts`): `pnpm telemetry:report [--since 7d] [--json]`, `pnpm telemetry:trace <suggestionId|contentId>` and `pnpm telemetry:prune --older-than <N>d` (no default age; nothing is pruned automatically). Calls are counted by their first attempt; latency is that of the answering attempt; p50/p95 use `percentile_cont`.
- **Evals.** The harness runs the real pipeline on its own database, so each eval result carries a `telemetry` block built by the same report code, and each article in the run details carries its trace ID.

## 18. Languages (`src/ai/language.ts`)

Three choices, read at call time so a change in Settings applies to the next model call without a restart:

| Choice | Setting | What it changes | Why |
|---|---|---|---|
| Output language | `OUTPUT_LANGUAGE` (default `LANGUAGE`) | The "answer in X" line of every prompt and the schema descriptions of the text fields; fixed texts Rekindle writes itself (`src/i18n/serverText.ts`): callout labels and dates, generated-note headings, placeholder observations | What the user reads |
| Notes language | `NOTES_LANGUAGE` (default `LANGUAGE`) | The language of summaries | The summary is what gets embedded and compared with the note embeddings. Summarizing every article into the notes' language, whatever the article's language, keeps the comparison within one language |
| Instruction language | `PROMPT_LANGUAGE` (internal, eval-only) | Spanish or English instructions for the summary and triage prompts (`src/ai/summarize.ts`, `src/evaluator/triagePrompt.ts`) | Kept on whatever measures best (`evals/REPORT.md`) |

With all three in Spanish the prompts are byte-identical to the ones measured before languages were configurable; `tests/eval_replay.test.ts`, whose recordings are keyed by exact prompt, proves it. Logic that used to read the model's Spanish (the disguised-discard filter, the parser of saved synergy notes) accepts both languages. API messages are English with a stable `code` for the errors a user can hit. Text already stored keeps the language it was written in.

## 19. Dormant projects (`src/vault/dormancy.ts`)

The problem Rekindle exists for is a project left alone for weeks. Each snapshot stores `notes_modified_at` (a `timestamptz`): the newest modification time among the project's own notes, with `suggestions.md` and Rekindle-generated notes excluded, so Rekindle's writes never make a project look active. Snapshots taken before this column existed are dated on the next reconcile without a new snapshot. `/api/projects` returns `notesModifiedAt`, `idleDays` and `isDormant` (`DORMANT_AFTER_DAYS = 14`). Each evaluation stores `project_idle_days`, computed in Node from that absolute instant (the database and Node clocks are never mixed), so "rekindles a project idle for N days" stays true after the project is edited again. Tests: `tests/dormancy.test.ts`, `tests/ui_dormancy.test.ts`.

## 17. Known Considerations & Future Roadmap

| Area | Current Behavior | Future Consideration |
|---|---|---|
| **Authentication** | No auth token. The server only binds to loopback, rejects any `Host` other than `127.0.0.1`/`localhost`/`[::1]` (blocks DNS rebinding), and rejects state-changing requests from foreign origins; the extension origin may only call `/api/ingest` (`src/api/requestGuard.ts`). | A per-install token if LAN access is ever needed. |
| **Privacy with Cloud LLM** | When `GEMINI_API_KEY` is set, Google receives: raw article text (up to 50,000 chars) for summaries; project notes (up to 15,000 chars) plus the article summary per evaluation and re-evaluation; every ready content summary plus every active note snippet per Consultor query; note snippets for synergies; accepted suggestions plus notes for synthesis. | Leave `GEMINI_API_KEY` empty for strict data residency. |
| **Virtual Evaluation State** | Accepting or discarding a tentative evaluation inserts its `action_suggestions` row (`ideas.md` / `discarded` target); the LLM verdict is left unchanged. A unique index on `evaluation_id` makes concurrent requests safe. | Separate user decision from model verdict. |
| **Ingestion SSRF guard** | `fetchPublicPage` validates every resolved IP at connect time (private, loopback, link-local, CGNAT, reserved, IPv6 ULA and IPv4-mapped ranges are blocked), re-checks each redirect hop and streams the body with a 5 MB cap. | — |
| **Prompt injection** | Untrusted text (pages, transcripts, summaries, notes, earlier suggestions, queries) is wrapped by `promptBlock` (`src/ai/promptSafety.ts`), which neutralizes tag-like sequences; `AiProvider` appends a rule to every system prompt that delimited content is data. Code-side limits (sanitized writes on accept only, validated target notes) are the real boundary. See `docs/THREAT_MODEL.md`. | Measure how often injected pages change verdicts (not measured). |
| **Multi-Vault Support** | Rekindle operates against a single active vault directory specified in `VAULT_PATH`. | Support multi-vault switching or profile presets in settings. |
