# Loom

Loom is a **local-first** assistant that connects what you read with what you write. You keep your projects as Markdown notes in an Obsidian vault; you paste web articles or YouTube videos into Loom; Loom summarises them, compares them semantically against your active projects, and proposes concrete actions ("cite this in Act 2", "counter-argument for this thesis"). Only the suggestions **you accept** are written back to your vault.

> The product UI, AI prompts and generated text are in **Spanish**. Code and developer documentation are in English.

📘 **Deep technical documentation:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## How it works

```
 URL ──► ingest ──► summarise (Gemini or Ollama) ──► embed (Ollama bge-m3) ──► PostgreSQL + pgvector
                                                                                    │
 Obsidian vault ──► watcher ──► reconcile project ──► snapshot + embedding ─────────┤
                                                                                    ▼
                                           cosine distance < 0.6 ──► LLM evaluation per project
                                                                                    │
                                    pending suggestion ──► you accept ──► callout in <project>/suggestions.md
```

- **Ingestion**: web pages (Readability) and YouTube (shorts/embed/live/youtu.be are canonicalised; transcripts via `youtube-transcript`). Tracking params and fragments are stripped from URLs. Fetches have a 15 s timeout, a 5 MB cap and a content-type check; only `http(s)` URLs are accepted.
- **Evaluation**: step 1 is a pgvector pre-filter against the *latest snapshot* of each active project; step 2 is one structured-output LLM call per matching project (`actionable` / `tentative` / `irrelevant`). Gemini is used when `GEMINI_API_KEY` is set; on any Gemini error it falls back to local Ollama.
- **Vault sync**: a watcher (3 s debounce) re-reads a project when its top-level `.md` files change, stores an immutable snapshot with a new embedding and re-evaluates past content that now matches.
- **Writeback**: accepting a suggestion appends a `> [!tip]` callout to `<project>/suggestions.md`. Pending and discarded suggestions never touch the vault.
- **Web UI**: Inbox (ingest + feed), Triage (per project, tabs for active/pending/tentative/accepted/discarded) and Settings (vault path, rescan).

### Vault layout

```
<vault>/
  Projects/            (or Proyectos/)
    My_Project/
      project.md       ← thesis source (or any note tagged #project / tags: [project])
      other-notes.md   ← every .md directly inside the folder is included
      suggestions.md   ← written by Loom, ignored when reading
```

Only `.md` files directly inside a project folder are read; sub-folders and attachments are ignored.

---

## Requirements

- **Node.js** `>= 22`
- **pnpm** (npm also works)
- **PostgreSQL 16 with `pgvector`** — `docker compose up -d postgres` provides it
- **Ollama** running locally with:
  ```bash
  ollama pull bge-m3              # embeddings (required)
  ollama pull qwen2.5:7b-instruct # local LLM (used when no Gemini key, or as fallback)
  ```
- **Gemini API key** *(optional)* — faster/better structured output. See the privacy note below.

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
pnpm run dev               # watch mode
pnpm start                 # plain start
start.bat                  # Windows: also starts Docker/Ollama checks, migrates and opens the browser
```

Open <http://127.0.0.1:3000>. Without `VAULT_PATH` the demo vault in [`demo_vault/`](demo_vault) is used.

---

## Privacy note

Embeddings are always computed locally. If `GEMINI_API_KEY` is set, the following leaves your machine for Google's API:

- the article text (up to 50,000 characters) for summarisation;
- for each evaluation, the project **thesis and up to 15,000 characters of your project notes**, plus the article summary.

Remove the key to keep everything local (Ollama only).

---

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (`@typescript-eslint`) |
| `pnpm test` | Vitest. Integration tests need **Docker** (Testcontainers) and some need a live **Ollama**. |
| `pnpm exec vitest run tests/parser.test.ts tests/youtube_ingest.test.ts tests/dummy.test.ts` | Offline unit tests only |
| `pnpm run db:generate` | Generate a Drizzle migration after editing `src/db/schema.ts` |
| `pnpm run db:migrate` | Apply migrations |
| `pnpm run db:seed` | Insert a single sample project row |
| `pnpm run db:reset` | ⚠️ Drops `public`, `drizzle` and `pgboss` schemas and re-migrates (`reset_db.bat` wraps it) |
| `tsx scripts/seed_demo.ts` | ⚠️ Deletes all rows and rebuilds demo data + `demo_vault` project |
| `tsx scripts/reconcile_and_reevaluate.ts` | ⚠️ Deletes all evaluations and pending suggestions, rescans the vault and re-evaluates every ready content |

---

## HTTP API (summary)

| Endpoint | Purpose |
|---|---|
| `POST /api/ingest` | Queue a URL (`202` new, `200` re-queued) |
| `GET /api/contents`, `GET /api/contents/:id` | Inbox feed and detail |
| `GET /api/projects`, `GET /api/projects/:id` | Projects with thesis and counters (`?isActive=true|false`) |
| `GET /api/suggestions`, `GET /api/suggestions/:id` | Triage feed (`status=active|pending|tentative|accepted|discarded`) |
| `PATCH /api/suggestions/:id` | Accept / discard (`409` if already resolved differently) |
| `GET/POST /api/settings/vault`, `POST /api/settings/vault/rescan` | Vault configuration and forced rescan |
| `GET /api/system/status`, `GET /health` | Activity and liveness |

Full contracts and semantics are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#11-http-api).

---

## Documentation

| Document | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, data model, pipelines, API, configuration, known issues |
| [docs/code-review.md](docs/code-review.md) | Code review findings and their current status |
| [docs/adr/](docs/adr) | Architecture decision records (Spanish) |
| [docs/fase-0-report.md … fase-7-report.md](docs) | Historical phase reports (Spanish), each with a post-review addendum |

---

## Known limitations

See [section 14 of ARCHITECTURE.md](docs/ARCHITECTURE.md#14-known-issues-and-open-questions). Highlights: no authentication (localhost-only by default), accepting a *tentative* item leaves its evaluation listed as tentative, a reconcile triggered while another one for the same project is running is skipped, and most automated tests require Docker/Ollama.

## Troubleshooting

- **Project never matches anything**: check Ollama is running with `bge-m3` (a failed embedding is retried on the next change/boot/rescan, nothing is stored meanwhile). Use *Settings → Rescan*.
- **`ECONNREFUSED 127.0.0.1:11434`**: start Ollama (`ollama serve`).
- **Ingestion fails with "Unsupported content type"**: only HTML/text pages are supported (no PDFs).
- **Nothing happens when notes change**: only top-level `.md` files in `Projects/<name>/` (or `Proyectos/`) are watched; `suggestions.md` and dot-folders are ignored.
- **Slow first request**: Ollama loads both models on first use (30–40 s).
