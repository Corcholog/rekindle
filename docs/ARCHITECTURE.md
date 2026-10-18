# Loom — Architecture & Technical Reference

> **Audience:** Engineers, contributors, and LLM reviewers who need to understand, audit, or extend Loom.  
> **State described:** git `master` after Phase 2 (security and integrity fixes; see `docs/agent/02-roadmap.md`). Behaviors marked **Known issue** are documented as they are today and are not fixed yet.  
> **Verification:** run `pnpm typecheck`, `pnpm lint` and `pnpm test`; per-phase results are recorded in `docs/JOURNEY.md`.

---

## 1. What Loom Is

Loom is a **local-first, human-in-the-loop intelligence layer** that connects what you read on the web with what you write in your personal knowledge base (Obsidian).

The workflow centers on writer agency:
1. **Writing projects as folders in Obsidian**: You maintain projects as collections of Markdown notes under `Projects/<ProjectName>/` (or `Proyectos/<ProjectName>/`).
2. **Seamless link capture**: You ingest web articles, essays, and YouTube videos via the web UI or the **Manifest V3 Web Clipper extension** (which queues clippings locally when offline and auto-syncs on reconnect).
3. **Structured summarization & local embedding**: Loom extracts the readable article text or video transcript, synthesizes a structured summary (in Spanish), and calculates a 1024-dimensional dense vector embedding locally via Ollama (`bge-m3`).
4. **Hierarchical semantic matching**: Loom compares the incoming content against both whole-project embeddings and granular note-level embeddings (`project_note_snapshots`) in PostgreSQL using `pgvector` cosine distance.
5. **Constructive triage & action proposal**: When cosine distance indicates semantic affinity (< 0.6), Loom prompts an LLM (Gemini with automatic local Ollama fallback) to formulate a concrete, constructive action targeting a specific note in your project (e.g., *"Citar evidencia en research/combat.md"*, *"Contraargumento para Acto 2"*).
6. **Explicit writeback**: Pending and tentative suggestions **never alter your vault**. Only suggestions you explicitly click **Aceptar** on are appended to your vault as native Obsidian callouts (`> [!tip]`) inside `<project>/suggestions.md`. Synergy bridge notes and research briefs are only written when you click **Guardar en Obsidian** (§11).
7. **Living knowledge synchronization**:
   - **Vector-gated staleness detection**: Detects when notes evolve in Obsidian and flags older suggestions as stale (`isStale`).
   - **Tentative promotions**: Automatically re-evaluates past tentative contents when project drafts expand or move closer.
   - **Cross-project thematic synergies**: Discovers conceptual bridges between separate projects via note-to-note cosine distance and generates bridge notes.
   - **Archive & Vault Research Partner ("Consultor")**: Evaluates your entire saved library and all active Obsidian notes simultaneously to diagnose research questions, assess project viability, and provide cited references (`[C1]`, `[N1]`).

### Core Design Principles
- **Obsidian is the primary source of truth**: The filesystem holds your creative writing. PostgreSQL holds derived vector index state, immutable snapshots, and triage history.
- **Zero unapproved mutations** (invariant I1): AI cannot write or edit notes without your explicit action. Suggestions are written only after **Aceptar**; generated notes only after **Guardar en Obsidian**, as new files that never overwrite anything. Model text is sanitized before it reaches the vault (`src/vault/sanitize.ts`).
- **Privacy & local-first foundation**: Vector embeddings are strictly calculated on-device via Ollama. Without `GEMINI_API_KEY`, every LLM call (summaries, evaluations, re-evaluations, Consultor, synergies, synthesis) runs locally with Ollama. Non-LLM outbound traffic remains: fetching the pages and YouTube metadata/transcripts you ingest, and the web fonts the UI loads from Google Fonts.
- **Language separation**: User-facing copy, prompts, generated summaries, callouts, and UI strings are strictly in **Spanish**. Source code, variables, developer documentation, and commits are strictly in **English**.

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
| **Web Frontend** | Vanilla ES Modules + HTML5 + custom CSS | Newsreader, Plus Jakarta Sans and JetBrains Mono (loaded from Google Fonts), Obsidian callout styling, no UI framework. |

---

## 3. Repository Layout

```
loom/
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
│  ├─ net/
│  │  └─ safeFetch.ts                 Public-internet-only page fetch (DNS-checked IPs, redirects, 5 MB cap)
│  └─ workers/
│     ├─ ingestionWorker.ts           Job processor for 'ingest_url' queue
│     ├─ evaluationWorker.ts          Job processor for 'evaluate_content' queue
│     └─ vaultWorker.ts               Job processor for 'sync_suggestions' recovery queue
├─ web/                               Single Page Application (served via Fastify static)
│  ├─ index.html                      Semantic HTML with 4 views (Consumo, Sugerencias, Consultor, Config)
│  ├─ app.js                          Frontend controller, state management, modal handlers
│  └─ styles.css                      Editorial design system
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
    UI["Web UI<br/>(web/app.js)"]
    EXT["Web Clipper Extension<br/>(Manifest V3)"]
    OFFLINE[("Offline Storage<br/>chrome.storage.local")]
    EXT <-->|Queue / Sync| OFFLINE
  end

  subgraph Server["Loom Server (Single Node.js Process)"]
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

Loom reads configuration through `src/config.ts`, which validates `process.env` against a strict Zod schema at startup:

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | `enum` | `'development'` | Application environment (`development`, `production`, `test`). |
| `HOST` | `string` | `'127.0.0.1'` | Network bind address. Must be `127.0.0.1`, `localhost` or `::1`; startup fails otherwise (the API has no authentication). |
| `PORT` | `number` | `3000` | HTTP listen port. |
| `DATABASE_URL` | `string` | `postgres://loom:loompassword@localhost:5432/loomdb` | PostgreSQL connection URI. |
| `OLLAMA_URL` | `string` | `http://127.0.0.1:11434` | Ollama service endpoint. |
| `EMBED_MODEL` | `string` | `'bge-m3'` | Dense embedding model name (must produce 1024-dimensional vectors). |
| `CHAT_MODEL` | `string` | `'gemini-3.1-flash-lite'` | Gemini model identifier. The Ollama chat model is `qwen2.5:7b-instruct`. |
| `LLM_PROVIDERS` | `string` | `'deepseek,gemini,ollama'` | Provider order: `deepseek`, `gemini`, `ollama`. Providers needing a key are skipped without one. Malformed output (empty, invalid JSON, schema mismatch) is retried once on the same provider; transport errors go straight to the next. |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | `string?` | – / `'deepseek-flash'` | DeepSeek through its OpenAI-compatible API, JSON mode with the schema in the prompt and thinking requested off (it is on by default at DeepSeek). |
| `GEMINI_MODEL` | `string?` | *optional* | Overrides `CHAT_MODEL` (read directly from `process.env`). |
| `GEMINI_API_KEY` | `string?` | *optional* | Google AI Studio API key. If omitted, every LLM call runs locally on Ollama. |
| `VAULT_PATH` | `string?` | *optional* | Absolute or relative path to the root of the Obsidian vault. `pnpm start/dev` default to `./demo_vault`; the UI can rewrite it in `.env`. |
| `LOG_LEVEL` | `string?` | `'warn'` | Fastify log level (read directly from `process.env`). |

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
    boolean written_to_vault
    timestamp resolved_at
  }

  llm_telemetry {
    uuid id PK
    telemetry_component component
    uuid suggestion_id FK
    text model_name
    integer latency_ms
    boolean is_success
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
   - Enables fine-grained targeting: Loom matches content directly to specific notes (`research/combat.md`, `ideas.md`) instead of diluting them into an aggregate project blob.
   - Indexes: HNSW cosine index `project_note_snapshots_embedding_idx`; foreign key indexes on `project_snapshot_id` and `project_id`.
5. **`evaluations`**:
   - The verdict (`actionable`, `tentative`, `irrelevant`) and reasoning of the LLM for a given `(content_id, project_snapshot_id)`.
   - Unique composite index on `(content_id, project_snapshot_id, consumption_seq)` prevents redundant LLM evaluations.
6. **`action_suggestions`**:
   - Concrete proposed actions generated when an evaluation is `actionable`.
   - `target_file` is the note the LLM proposed (falling back to the closest-affinity note, then `ideas.md`). It is shown in the UI and used for staleness detection; it is **not** used for writing: accepted callouts always go to `<project>/suggestions.md`.
   - Partial btree index `action_suggestions_status_partial_idx` on `status` where `status = 'pending'`.
7. **`llm_telemetry`**:
   - Currently written only for the evaluator's triage call, and only on success (model name and latency). Token, cost and error columns exist but are not populated yet (Phase 4).

---

## 7. The Obsidian Integration (`src/vault/`)

### 7.1 Recursive Vault Layout & Project Recognition
Loom monitors two top-level directories: `Projects/` and `Proyectos/`.
- **Recursive note structure**: Projects are represented by directory folders (e.g. `Projects/SciFi_Novel/`). Notes can live at the root of the project or in nested subdirectories (e.g. `Projects/SciFi_Novel/worldbuilding/factions.md`).
- **No mandatory `project.md`**: Loom does not force a rigid `project.md` file. The project thesis and title are derived heuristically:
  1. If a note carries the `#project` tag (inline or frontmatter `tags: [project]`), its text is the thesis and its H1 title becomes the project title.
  2. Otherwise the project title is the folder name and the thesis is the first 800 characters of the concatenated notes.
- **Excluded patterns**: Hidden files/folders (`.obsidian/`, `.trash/`, `.git/`), attachments, Loom's own output file (`suggestions.md`) and notes Loom generated (frontmatter `loom_generated: true`, or `type: research_brief` / `cross_project_synergy` from earlier versions) are ignored during parsing and hashing, so generated text never feeds back into project context.

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
- Each callout ends with a hidden Obsidian comment, `%% loom:<suggestion id> %%`.
- The write runs in a transaction that locks the suggestion row (`SELECT … FOR UPDATE`): read `suggestions.md`; append the callout only if its marker is absent; then set `written_to_vault = true`. A crash after the append leaves the marker, so the retry only sets the flag (invariant I5).
- If the write fails, the flag stays `false` and a `sync_suggestions` job retries; every pending writeback is also retried when the server starts.
- The project folder must already exist inside the vault; Loom never creates it (this matters after switching vaults).
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
Loom includes a full Manifest V3 browser extension for 1-click clipping from Chromium-based browsers:
- **Instant Clipping**: Action popup and context menu let users clip the active tab URL or highlighted text selection.
- **Offline Resilience**: If the Loom server is offline or unreachable, clippings are not lost; they are stored in `chrome.storage.local` with an amber badge indicator showing the queued count.
- **Background Auto-Sync**: The service worker (`extension/background.js`) flushes queued clippings to `POST /api/ingest` from a `chrome.alarms` timer (every minute while the queue is non-empty), on tab activation, on browser startup and right after enqueueing. The popup (`popup.js`) can also flush the queue directly. **Known issue:** both flush paths read and rewrite the same storage key without coordination, so a clip can be sent twice or dropped.
- The extension reaches Loom through its `host_permissions` (`localhost:3000`, `127.0.0.1:3000`), so the server sends no CORS headers. It is the only supported browser clipper.

---

## 9. Hierarchical Evaluation Pipeline

Evaluation is triggered by the `evaluate_content` queue (either for newly ingested content or during project backlog reconciliation).

### Step 1: Spatial Semantic Pre-filter (PostgreSQL pgvector)
Loom performs a combined vector search querying both project-level and note-level embeddings:
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
3. **Target File Resolution**: If the LLM specifies `targetFile`, it is stored as-is (not validated against the project's notes); otherwise it falls back to `matchedNotePath`, or finally `ideas.md`.
4. **Anti-Discard Guardrail**: If an actionable verdict paradoxically recommends discarding the content, Loom automatically downgrades the verdict to `irrelevant` and appends the explanation to `triageReasoning`.
5. **Idempotency**: an evaluation is skipped if one exists for the same `(content_id, project_snapshot_id, consumption_seq)`. Re-ingesting a known URL does not re-queue it or change `consumption_seq` (now always 1), so it never re-runs evaluation (invariant I6). Each evaluation has at most one suggestion (unique `action_suggestions.evaluation_id`).
6. **Failure handling** — **Known issue:** an LLM error for one project is logged and skipped; the job still completes, so it is not retried and no failure is recorded in telemetry.
7. **Embedding model**: only embeddings produced by the current `EMBED_MODEL` are compared; contents and snapshots from another model are skipped until re-embedded (invariant I7).

### Step 3: Backlog Re-evaluation & Tentative Promotions
When a project's notes change:
- `findBacklogUnevaluatedContents`: Evaluates ready contents that were never checked against the project.
- **Tentative Promotion Engine**: If a past evaluation was `tentative`, Loom automatically checks if:
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
As the user writes notes in Obsidian, previously generated suggestions may become out of date. Loom dynamically computes `isStale` and `driftScore` in SQL without requiring manual invalidation:
- **Snapshot Drift**: If the current snapshot embedding diverges from the snapshot at evaluation time by `>= STALE_DRIFT_THRESHOLD` (`0.04`).
- **Target Note Drift / Deletion**: If the specific note targeted by `targetFile` has drifted by `>= 0.04` or was deleted from the vault.
- Stale suggestions display a visual badge in the UI and provide a **Reevaluar** action.

### Context-Aware Re-evaluation (`POST /api/suggestions/:id/reevaluate`)
When re-evaluating a stale suggestion:
1. Loom loads the original suggestion, the content summary, and the **latest project snapshot** from the database (all notes concatenated, capped at 15,000 characters).
2. The LLM evaluates whether the suggestion should be:
   - `keep_or_refine`: Kept and updated with refined observations matching the new draft.
   - `already_addressed`: Auto-resolved because the writer already incorporated the ideas.
   - `obsolete`: Discarded because the draft moved in a completely different direction.

---

## 11. Synergies, Backlog Synthesis & Archive Consultant

### 11.1 Cross-Project Thematic Synergies (`/api/projects/synergies`)
Loom discovers hidden connections across separate projects by calculating the cosine distance between notes of different projects (`project_note_snapshots` where `pA.id != pB.id`):
- `GET /api/projects/synergies`: Returns high-affinity project pairs, closest matching notes, and semantic similarity scores.
- `POST /api/projects/synergies/explore`: Prompts the LLM to analyze the overlap between both projects and returns a bridge note (shared problems, mutual benefits, markdown). It does **not** write to the vault. If a bridge note already exists on disk, it is returned instead of calling the LLM (`forceRegenerate` skips that).
- `POST /api/projects/synergies/save` (the **Guardar en Obsidian** button): writes the note shown in the UI as `synergy_<A>_<B>.md` in project A's projects directory (`Projects/` or `Proyectos/`), sanitized and marked `loom_generated: true`. An existing file is never overwritten; a timestamped name is used instead.
- **Known issue:** the note-to-note comparison and the notes sent to the LLM are taken from all historical snapshots, not just the latest one, so deleted notes can still appear.

### 11.2 Project Backlog Synthesis (`/api/projects/:id/synthesize`)
Compiles the project's **accepted** suggestions and latest notes into a Research Brief via the LLM and returns it without writing anything. `POST /api/projects/:id/synthesis/save` (the **Guardar en Obsidian** button) writes it to the project folder as `research_brief.md`, or a timestamped name if that file exists. Saved briefs are sanitized, marked `loom_generated: true`, and excluded from the project's notes and embeddings.

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
  - Body: `{ status: 'accepted' | 'discarded', userFeedback? }`
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

The Loom frontend is a responsive single-page application built with modern vanilla ES Modules and custom CSS:
- **Editorial Design System**: Newsreader (serif), Plus Jakarta Sans (sans) and JetBrains Mono (code), loaded from Google Fonts.
- **Four Core Views**:
  1. **Consumo (`#view-inbox`)**: Input card for pasting URLs, active worker progress indicator, and chronological reading history feed with status pills.
  2. **Sugerencias (`#view-triage`)**: Project sidebar with unread counters, status tabs (Activas, Pendientes, Tentativas, Aceptadas, Descartadas), suggestion cards with inline Obsidian callouts, staleness pills, and one-click accept/discard/reevaluate actions. Includes the **Sintetizar Backlog** trigger.
  3. **Consultor (`#view-consultant`)**: Natural language research partner interface with interactive prompt chips, structured diagnosis card, and split-column citation cards linking library items and Obsidian notes.
  4. **Configuración (`#view-settings`)**: Vault path configuration, drive status indicator, rescan action, and detected projects table.
- **Dynamic Modals**:
  - Content Detail Modal (full text snippet, summary, per-project verdicts).
  - Extension Guide Modal (how to load the Manifest V3 clipper).
  - Synergy Bridge Modal (cross-project bridge note, written to the vault).
  - Synthesis Result Modal (research brief summary and next steps).
- All server and LLM text is HTML-escaped before rendering (`escapeHtml`); links go through `safeUrl` (http/https only).

---

## 14. Tooling, Tests and Operations

### Development & Operational Commands
```bash
pnpm run dev               # Start server in watch mode with tsx
pnpm start                 # Start production server
pnpm typecheck             # Run tsc --noEmit
pnpm lint                  # Run ESLint over codebase
pnpm test                  # Run Vitest test suites
pnpm test:coverage         # Same, with v8 line/branch coverage for src/
pnpm run db:generate       # Generate a migration after editing src/db/schema.ts
pnpm run db:migrate        # Apply Drizzle migrations to PostgreSQL
pnpm run db:reset          # Drop schemas and re-migrate (destructive)
```

### Automated Test Suites (`tests/`)
- **Unit Tests (Offline, Zero-dependency)**:
  - `tests/parser.test.ts`: Markdown parsing, frontmatter extraction, inline `#project` hashtags.
  - `tests/youtube_ingest.test.ts`: YouTube URL canonicalization, Shorts/embed mappings.
  - `tests/extension_offline.test.ts`: Extension manifest and offline-queue source checks.
  - `tests/request_guard.test.ts`, `tests/safe_fetch.test.ts`: Host/Origin guard and SSRF protection (local HTTP servers).
  - `tests/vault_sanitize.test.ts`, `tests/generated_notes.test.ts`, `tests/env_writer.test.ts`: vault-write sanitization, generated notes, `.env` writer.
  - `tests/invariants.test.ts`: invariants I2, I3 and I4 with mocked LLM SDKs.
- **Integration Tests (Require Docker / Testcontainers; most also need a local Ollama with `bge-m3` and `qwen2.5:7b-instruct`)**:
  - `tests/db.test.ts`: Database schema validation, pgvector HNSW cosine KNN operations.
  - `tests/evaluation.test.ts` & `tests/ingestion.test.ts`: Worker pipeline tests.
  - `tests/phase6_lifecycle.test.ts` & `tests/phase7_ui.test.ts`: API route tests via Fastify `inject`.
  - `tests/settings_vault.test.ts`: Vault path configuration and reconciliation tests.
  - `tests/vector_gated_staleness.test.ts`: Staleness detection and re-evaluation.
  - `tests/writeback_recovery.test.ts`, `tests/tentative_accept_race.test.ts`: crash-safe, single-callout writeback (I5).
  - `tests/reingest_idempotency.test.ts`, `tests/embedding_model.test.ts`: invariants I6 and I7.
  - `tests/error_responses.test.ts`: 500 responses do not leak internal errors.
  - `tests/ollama.test.ts`: Live Ollama embedding and structured-output checks.
  - `tests/full_e2e.test.ts`: Full end-to-end flow from URL ingestion to Obsidian writeback. Requires a real `GEMINI_API_KEY`; skipped otherwise.
- There is no fake LLM provider yet, so AI behavior is only tested against live models (Phase 5).

---

## 15. Evaluation harness (`evals/`)

`pnpm eval run <dataset> --config <file>` measures retrieval and triage quality. It starts a throwaway Postgres, reconciles the dataset's vault with the real reconciler, summarizes and embeds each labeled article, runs `retrieveCandidates` and `evaluateContentMatch`, and compares the verdicts with the owner's `labels.yaml`. Embeddings, summaries and LLM answers are cached per dataset, so a recorded dataset replays offline and deterministically (`--replay`). The runner swaps in its record/replay layer through `AiProvider.setOverrides()`; production code paths are otherwise unchanged. See `evals/README.md` for the workflow, the metrics and the privacy rules. Real notes and labels live only in the git-ignored `evals/private/`. Each run also writes `<dataset>/runs/<config>.json` (summaries, retrieval distances and every model's verdict, reasoning and suggested action); `pnpm eval:review <dataset>` serves a local page (127.0.0.1, same Host/Origin guard as the API) that shows those answers next to the owner's labels, saves corrections to `labels.yaml` and re-scores live with the same `scoreRun` function the runner uses.

## 16. Known Considerations & Future Roadmap

| Area | Current Behavior | Future Consideration |
|---|---|---|
| **Authentication** | No auth token. The server only binds to loopback, rejects any `Host` other than `127.0.0.1`/`localhost`/`[::1]` (blocks DNS rebinding), and rejects state-changing requests from foreign origins; the extension origin may only call `/api/ingest` (`src/api/requestGuard.ts`). | A per-install token if LAN access is ever needed. |
| **Privacy with Cloud LLM** | When `GEMINI_API_KEY` is set, Google receives: raw article text (up to 50,000 chars) for summaries; project notes (up to 15,000 chars) plus the article summary per evaluation and re-evaluation; every ready content summary plus every active note snippet per Consultor query; note snippets for synergies; accepted suggestions plus notes for synthesis. | Leave `GEMINI_API_KEY` empty for strict data residency. |
| **Virtual Evaluation State** | Accepting or discarding a tentative evaluation inserts its `action_suggestions` row (`ideas.md` / `discarded` target); the LLM verdict is left unchanged. A unique index on `evaluation_id` makes concurrent requests safe. | Separate user decision from model verdict. |
| **Ingestion SSRF guard** | `fetchPublicPage` validates every resolved IP at connect time (private, loopback, link-local, CGNAT, reserved, IPv6 ULA and IPv4-mapped ranges are blocked), re-checks each redirect hop and streams the body with a 5 MB cap. | — |
| **Multi-Vault Support** | Loom operates against a single active vault directory specified in `VAULT_PATH`. | Support multi-vault switching or profile presets in settings. |
