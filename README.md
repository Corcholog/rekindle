# Loom

Loom is a **local-first** assistant that connects what you read with what you write. You keep your writing projects as Markdown notes in an Obsidian vault; you clip web articles or YouTube videos into Loom; Loom summarises them, compares them semantically against your active projects and individual notes, and proposes concrete actions ("cite this in Act 2", "counter-argument for combat mechanics"). Only the suggestions **you accept** are written back to your vault.

> The product UI, AI prompts and generated text are in **Spanish**. Code and developer documentation are in English.

📘 **Deep technical documentation:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## How it works

```
 URL (Web / Extension) ──► ingest ──► summarise (Gemini or Ollama) ──► embed (Ollama bge-m3) ──► PostgreSQL + pgvector
                                                                                                      │
 Obsidian vault ──► watcher ──► reconcile notes ──► hierarchical snapshots + embeddings ──────────────┤
                                                                                                      ▼
                                              cosine distance < 0.6 ──► LLM evaluation per project & note
                                                                                                      │
                                       pending suggestion ──► you accept ──► callout in <project>/suggestions.md
```

- **Ingestion & Web Clipper**: Ingest links directly from the Web UI or via the **Manifest V3 Web Clipper extension** (`extension/`). The clipper supports offline queueing in `chrome.storage.local` with background auto-sync when Loom reconnects. Web pages (Readability) and YouTube (shorts/embed/live/youtu.be transcripts) are canonicalised, stripped of tracking params, and capped safely.
- **Hierarchical Evaluation**: Step 1 is a pgvector pre-filter checking both project snapshots and granular note snapshots (`project_note_snapshots`); step 2 is a structured-output LLM call with focal note context targeting specific files in your vault. Gemini is used when `GEMINI_API_KEY` is set; on any Gemini error it seamlessly falls back to local Ollama (`qwen2.5:7b-instruct`).
- **Living Vault Sync & Staleness**: A watcher (3 s debounce) re-reads project notes recursively, updates immutable snapshots, and computes vector drift (`STALE_DRIFT_THRESHOLD = 0.04`). Stale suggestions are flagged with badges and can be re-evaluated context-aware against updated drafts.
- **Synergies & Consultor**:
  - **Cross-Project Thematic Synergies**: Discovers conceptual bridges between different projects via note-to-note vector distance and synthesizes bridge notes.
  - **Archive & Vault Research Partner ("Consultor")**: Answers natural language research questions by reasoning across your entire saved library and all active Obsidian project notes simultaneously, generating verified inline citations (`[C1]`, `[N1]`).
- **Explicit Writeback**: Accepting a suggestion appends a native Obsidian `> [!tip]` callout to `<project>/suggestions.md`. Pending, tentative, and discarded suggestions never touch the vault.
- **Web UI**: 4 focused views:
  1. **Consumo**: Ingestion input card and chronological reading history feed.
  2. **Sugerencias**: Project-scoped triage with staleness pills, backlog synthesis, and accept/discard/reevaluate actions.
  3. **Consultor**: Full-catalog research consultant with interactive prompt chips.
  4. **Configuración**: Vault directory configuration, disk mount status, and forced rescan.

### Vault layout

```
<vault>/
  Projects/            (or Proyectos/)
    My_Project/
      ideas.md         ← note tagged #project (or frontmatter tags: [project])
      chapter1.md      ← any markdown note
      research/
        sources.md     ← recursive subdirectories are fully indexed
      suggestions.md   ← written by Loom, ignored when reading
```

Notes inside project folders are indexed recursively. No mandatory `project.md` file is required. Attachments and `.obsidian` configurations are safely ignored.

---

## Requirements

- **Node.js** `>= 22`
- **pnpm** (npm also works)
- **PostgreSQL 16 with `pgvector`** — `docker compose up -d postgres` provides it
- **Ollama** running locally with:
  ```bash
  ollama pull bge-m3              # embeddings (required, 1024-d)
  ollama pull qwen2.5:7b-instruct # local LLM (used when no Gemini key, or as fallback)
  ```
- **Gemini API key** *(optional)* — faster structured output. See the privacy note below.

---

## Getting started

### 1. Configure

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Keep it local: the API has no authentication. |
| `PORT` | `3000` | HTTP port. |
| `DATABASE_URL` | `postgres://loom:loompassword@localhost:5432/loomdb` | Matches `docker-compose.yml`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `EMBED_MODEL` | `bge-m3` | Embedding model. The DB column is `vector(1024)`, so the model must output 1024 dims. |
| `CHAT_MODEL` | `gemini-3.1-flash-lite` | **Gemini** model name. (The Ollama chat model is fixed to `qwen2.5:7b-instruct`.) |
| `GEMINI_MODEL` | – | Optional override of `CHAT_MODEL`. |
| `GEMINI_API_KEY` | – | Enables Gemini. Leave empty for 100% local operation. |
| `VAULT_PATH` | `./demo_vault` (via `pnpm start/dev`) | Obsidian vault root. Can also be changed in the UI (it rewrites this line in `.env`). |
| `LOG_LEVEL` | `warn` | Fastify log level. |

### 2. Install and migrate

```bash
pnpm install
docker compose up -d postgres
pnpm run db:migrate        # enables pgvector and applies Drizzle migrations
```

### 3. Run

```bash
# On Linux / macOS:
./start.sh                 # or pnpm run dev / pnpm start

# On Windows:
start.bat                  # checks Docker/Ollama, migrates, opens browser and launches dev
```

Open <http://127.0.0.1:3000>. Without `VAULT_PATH` the demo vault in [`demo_vault/`](demo_vault) is used.

### 4. Browser Extension (Optional)

1. Open Chrome/Brave/Edge and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in upper right).
3. Click **Load unpacked** and select the [`extension/`](extension) folder from this repository.
4. Pin the **Loom Web Clipper** icon for 1-click clipping from any webpage.

---

## Privacy note

Embeddings are always computed locally. If `GEMINI_API_KEY` is set, the following leaves your machine for Google's API:

- the article text (up to 50,000 characters) for summarisation;
- for each evaluation, the project **thesis and up to 15,000 characters of your project notes**, plus the article summary.

Remove or omit `GEMINI_API_KEY` to keep everything 100% local (Ollama only).

---

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (`@typescript-eslint`) |
| `pnpm test` | Vitest. Offline unit tests run instantly; integration tests use Docker / Ollama. |
| `pnpm exec vitest run tests/parser.test.ts tests/youtube_ingest.test.ts` | Offline unit tests only |
| `pnpm run db:generate` | Generate a Drizzle migration after editing `src/db/schema.ts` |
| `pnpm run db:migrate` | Apply migrations |
| `pnpm run db:reset` | ⚠️ Drops `public`, `drizzle` and `pgboss` schemas and re-migrates (`reset_db.sh` / `reset_db.bat`) |

---

## HTTP API Summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ingest` | `POST` | Queue a URL (`202` new, `200` re-queued) |
| `/api/contents`, `/api/contents/:id` | `GET` | Reading feed, status indicators, and content details |
| `/api/library/consult` | `POST` | Full-catalog Archive & Obsidian Vault Research Partner |
| `/api/library/search`, `/api/library/ask` | `GET` / `POST` | Semantic vector search and RAG Q&A with citations |
| `/api/projects`, `/api/projects/:id` | `GET` | Projects list with counters and note metadata |
| `/api/projects/synergies` | `GET` | Cross-project thematic synergies via HNSW note distance |
| `/api/projects/synergies/explore` | `POST` | AI synergy exploration and Obsidian bridge note generation |
| `/api/projects/:id/synthesize` | `POST` | Synthesize project backlog into research brief |
| `/api/suggestions`, `/api/suggestions/:id` | `GET` | Triage feed with staleness scores (`status=active\|pending\|tentative\|accepted\|discarded`) |
| `/api/suggestions/:id` | `PATCH` | Accept / discard suggestion (`409` on conflict) |
| `/api/suggestions/:id/reevaluate` | `POST` | Context-aware re-evaluation of suggestion against current notes |
| `/api/projects/:id/reevaluate-stale` | `POST` | Batch re-evaluation of all stale suggestions for a project |
| `/api/settings/vault`, `.../rescan` | `GET` / `POST` | Vault path configuration, drive validation, and forced rescan |
| `/api/system/status`, `/health` | `GET` | Real-time queue activity indicator and liveness check |

Full contracts, schemas, and semantics are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#12-complete-http-api-reference).

---

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **In-depth technical reference**: Architecture, data model, pipelines, API, configuration, and design |
| [docs/code-review.md](docs/code-review.md) | Code review findings and historical status |
| [docs/adr/](docs/adr) | Architecture decision records (Spanish) |
| [docs/fase-0-report.md … fase-7-report.md](docs) | Historical phase reports (Spanish) |

---

## Troubleshooting

- **Project never matches anything**: check Ollama is running with `bge-m3` (a failed embedding is retried on the next change/boot/rescan, nothing is stored meanwhile). Use *Configuración → Rescan*.
- **`ECONNREFUSED 127.0.0.1:11434`**: start Ollama (`ollama serve`).
- **Ingestion fails with "Unsupported content type"**: only HTML/text pages are supported (no binary PDFs).
- **Secondary Linux drive not detected**: if your vault is on an NTFS/removable partition (`/run/media`), Loom attempts auto-mounting via `udisksctl`. Ensure your user has mount permissions.
- **Slow first request**: Ollama loads models on first invocation (30–40 s cold start).
