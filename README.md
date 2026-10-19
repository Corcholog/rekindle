# Loom

[![CI](https://github.com/Corcholog/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/Corcholog/loom/actions/workflows/ci.yml)

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
- **Hierarchical Evaluation**: Step 1 is a pgvector pre-filter checking both project snapshots and granular note snapshots (`project_note_snapshots`); step 2 is a structured-output LLM call with focal note context targeting specific files in your vault. Providers are tried in the order of `LLM_PROVIDERS` (default DeepSeek, then Gemini, then local Ollama `qwen2.5:7b-instruct`); a provider without a key is skipped and a failure moves to the next one.
- **Living Vault Sync & Staleness**: A watcher (3 s debounce) re-reads project notes recursively, updates immutable snapshots, and computes vector drift (`STALE_DRIFT_THRESHOLD = 0.04`). Stale suggestions are flagged with badges and can be re-evaluated context-aware against updated drafts.
- **Synergies & Consultor**:
  - **Cross-Project Thematic Synergies**: Discovers conceptual bridges between different projects via note-to-note vector distance and drafts a bridge note you can save to the vault.
  - **Archive & Vault Research Partner ("Consultor")**: Answers natural language research questions by reasoning across your entire saved library and all active Obsidian project notes simultaneously, citing sources as `[C1]` (library) and `[N1]` (notes). The cited cards are checked against the catalog; inline references in the answer text are not yet verified.
- **Explicit Writeback**: Accepting a suggestion appends a native Obsidian `> [!tip]` callout to `<project>/suggestions.md`. Pending, tentative, and discarded suggestions never touch the vault. Synergy notes and research briefs are saved only when you click **Guardar en Obsidian**.
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
| `HOST` | `127.0.0.1` | Bind address. Must be loopback (`127.0.0.1`, `localhost`, `::1`); the API has no authentication. |
| `PORT` | `3000` | HTTP port. |
| `DATABASE_URL` | `postgres://loom:loompassword@localhost:5432/loomdb` | Matches `docker-compose.yml`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `EMBED_MODEL` | `bge-m3` | Embedding model. The DB column is `vector(1024)`, so the model must output 1024 dims. |
| `CHAT_MODEL` | `gemini-3.1-flash-lite` | **Gemini** model name. (The Ollama chat model is fixed to `qwen2.5:7b-instruct`.) |
| `GEMINI_MODEL` | – | Optional override of `CHAT_MODEL`. |
| `LLM_PROVIDERS` | `deepseek,gemini,ollama` | Order in which LLM providers are tried (`deepseek`, `gemini`, `ollama`). Providers without a key are skipped; malformed output is retried once, then the next provider is used. |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | – / `deepseek-flash` | Enables DeepSeek when listed in `LLM_PROVIDERS`. Thinking mode is requested off. |
| `GEMINI_API_KEY` | – | Enables Gemini. Leave empty for 100% local operation. |
| `VAULT_PATH` | `./demo_vault` (via `pnpm start/dev`) | Obsidian vault root. Can also be changed in the UI (it rewrites this line in `.env`). |
| `LOG_LEVEL` | `info` | Server log level (structured logs shared with Fastify). |
| `LOG_FORMAT` | `pretty` | `pretty` for one readable line per record, `json` for raw JSON lines (default in production). |

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
- for each evaluation and re-evaluation, **up to 15,000 characters of your project notes**, plus the article summary;
- for each Consultor question, **the summaries of every ready item in your library and a snippet of every active project note**;
- for synergies, note snippets from both projects; for backlog synthesis, your accepted suggestions plus up to 10,000 characters of project notes.

With a `DEEPSEEK_API_KEY` set (the default chain is `deepseek,gemini,ollama`), the same content goes to DeepSeek first (a China-hosted API) and to Gemini only if DeepSeek fails; without that key DeepSeek is skipped. Leave both keys empty and every LLM call runs on local Ollama. Loom still contacts the sites you ingest (and YouTube for transcripts), and the web UI loads its fonts from Google Fonts.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (`@typescript-eslint`) |
| `pnpm test` | Vitest. Needs Docker: integration tests start throwaway pgvector databases with Testcontainers. No Ollama or API key is needed: a deterministic fake stands in for the models. CI runs this on every push. |
| `pnpm test:coverage` | Same, with v8 coverage for `src/` |
| `LOOM_LIVE_TESTS=1 pnpm test` | Also runs the opt-in live checks against local Ollama and the real DeepSeek and Gemini APIs (keys from `.env`); by default tests never reach a model |
| `pnpm exec vitest run tests/parser.test.ts tests/youtube_ingest.test.ts` | Offline unit tests only |
| `pnpm run db:generate` | Generate a Drizzle migration after editing `src/db/schema.ts` |
| `pnpm run db:migrate` | Apply migrations |
| `pnpm run db:reset` | ⚠️ Drops `public`, `drizzle` and `pgboss` schemas and re-migrates (`reset_db.sh` / `reset_db.bat`) |
| `pnpm telemetry:report --since 7d` | Per-stage latency, LLM failure / fallback / malformed rates, tokens and estimated cost for a period |
| `pnpm telemetry:trace <suggestionId\|contentId>` | Follows a suggestion back to its content, the retrieval step that selected it, every stage and every LLM attempt |
| `pnpm telemetry:prune --older-than 90d` | ⚠️ Deletes telemetry rows and pipeline events older than the given age (never runs automatically) |

---

## HTTP API Summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ingest` | `POST` | Queue a URL (`202` new, `200` re-queued) |
| `/api/contents`, `/api/contents/:id` | `GET` | Reading feed, status indicators, and content details |
| `/api/library/consult` | `POST` | Full-catalog Archive & Obsidian Vault Research Partner |
| `/api/projects` | `GET` | Projects list with counters and note metadata |
| `/api/projects/synergies` | `GET` | Cross-project thematic synergies via note-to-note cosine distance |
| `/api/projects/synergies/explore` | `POST` | AI synergy exploration (writes nothing) |
| `/api/projects/synergies/save` | `POST` | Save a bridge note to the vault as a new file |
| `/api/projects/:id/synthesize` | `POST` | Compile accepted suggestions into a research brief (writes nothing) |
| `/api/projects/:id/synthesis/save` | `POST` | Save the research brief to the vault as a new file |
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
| [docs/adr/](docs/adr) | Architecture decision records (Spanish) |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Assets, untrusted inputs, each mitigation and the test that proves it, residual risks |
| [docs/JOURNEY.md](docs/JOURNEY.md) | Build log: decisions, dead ends, bugs found and fixed |

---

## Evaluation

`pnpm eval` runs Loom's real retrieval and triage against articles and projects labeled by a person (see [`evals/README.md`](evals/README.md)); the full tables are in [`evals/REPORT.md`](evals/REPORT.md). Latest run, one labeler (the project owner), 47 articles × 8 projects = 376 labeled pairs (31 actionable, 20 tentative, 325 irrelevant), each provider alone with no fallback, identical summaries and retrieval:

| | Gemini 3.1 Flash Lite | **DeepSeek Flash** (thinking off) | Qwen 2.5 7B (local) |
|---|---|---|---|
| Triage macro-F1 | 0.56 | **0.74** | 0.61 |
| `actionable` precision / recall | 44% / 100% | **94% / 97%** | 100% / 39% |
| Target-note accuracy (19 pairs) | 37% | 42% | 32% |
| Latency p50 / p95 | 4.2 / 6.7 s | **2.1 / 4.1 s** | 3.4 / 7.6 s |
| Cost of 215 triage calls | free tier (4 overloads retried) | about $0.18 at list price | $0 |

DeepSeek leading is why the default chain is `deepseek,gemini,ollama`. Since Phase 5 a suggestion can only name an existing note of its project; replaying the recorded answers (top-3 configs) with that check raises Gemini's target-note accuracy to 47% (9 of 19), while DeepSeek and Qwen are unchanged. These numbers come from a small, single-labeler dataset: treat gaps of a few points as noise. Retrieval at the 0.6 distance threshold finds 91% of the relevant projects but lets 94% of unrelated articles through (precision@3 55%). Suggestion quality (usefulness, actionability) is **not measured**.

## Observability

Every ingestion starts a trace that follows the article through fetch, extraction, summary, embedding, retrieval and triage to its suggestions. Each stage and each LLM attempt (provider, retries, fallbacks, errors, tokens, estimated cost) is stored in Postgres, and `pnpm telemetry:report` and `pnpm telemetry:trace` read it back. Logs and telemetry hold IDs, counts, lengths, hashes and durations only: no note text, article text, prompt, model output or URL (`tests/pipeline_trace.test.ts` checks this with planted sentinel strings). Production latency, failure and cost figures on the owner's real use are **not measured** yet. See [ARCHITECTURE §16](docs/ARCHITECTURE.md#16-observability-srcobservability).

## Security model

Loom is a single-user, local-only tool:

- **Network:** the API has no login. It only binds to loopback (`HOST` must be `127.0.0.1`, `localhost` or `::1`), and it rejects requests addressed to any other host name, which blocks DNS rebinding. It also rejects state-changing requests from other web origins. The browser extension may only call `/api/ingest`.
- **Your vault:** Loom writes only when you act. **Aceptar** appends a callout to `<project>/suggestions.md`; **Guardar en Obsidian** saves a synergy note or research brief as a new file and never overwrites one. Model text is sanitized first: code blocks, embeds, HTML and fake callouts are neutralized.
- **Ingestion:** only public `http(s)` pages are fetched. Every resolved IP address and every redirect is checked, and pages are capped at 5 MB.
- **Prompt injection:** pages and notes are untrusted. Their text is delimited so it cannot break out of its block, every prompt says delimited text is data, and the limits that matter are enforced in code: a suggestion can only point at an existing note of its project, and nothing reaches the vault unless you accept it, sanitized.

The full list of threats, mitigations, tests and residual risks is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Known limitations

- **The 0.6 distance threshold barely filters.** On the evaluation set 94% of unrelated articles still retrieved a project, so every article costs about 4.6 LLM calls. [`evals/SWEEP.md`](evals/SWEEP.md) compares cutoffs: only the 3 closest projects now reach the LLM (`TOP_K_PROJECTS_LIMIT = 3`), which cut calls by 45% and keeps 86% of the relevant pairs, but 1 in 8 relevant pairs is never evaluated.
- **Tentative and target-note judgements are weak for every model tried.** `tentative` F1 is 0.18–0.38 and the right target note is chosen in 32–47% of cases (small samples: 20 and 19 pairs).
- **The evaluation numbers predate the Phase 5 prompt changes.** Every prompt gained injection defenses in Phase 5; the private set has not been re-run since, so the table above describes the earlier prompts.
- **Suggestion quality (usefulness, actionability) is not measured.** Only verdicts and target notes are scored, against one person's labels.
- **A failed evaluation is invisible in the UI.** If the LLM fails while evaluating an article for a project, the job is retried three times (after 30 s, 60 s and 120 s); after that the pair waits until the project changes. Only `pnpm telemetry:report` shows the failure.
- **The Consultor sends your whole library in one prompt.** Large libraries can exceed the local model's context window.
- **Synergies may include deleted notes**, because they compare notes from older project snapshots too.
- **The extension can send a queued clip twice** when two sync triggers fire at once. Re-ingesting is harmless; it no longer creates duplicate suggestions.

---

## Troubleshooting

- **Project never matches anything**: check Ollama is running with `bge-m3` (a failed embedding is retried on the next change/boot/rescan, nothing is stored meanwhile). Use *Configuración → Rescan*.
- **`ECONNREFUSED 127.0.0.1:11434`**: start Ollama (`ollama serve`).
- **Ingestion fails with "Unsupported content type"**: only HTML/text pages are supported (no binary PDFs).
- **Secondary Linux drive not detected**: if your vault is on an NTFS/removable partition (`/run/media`), Loom attempts auto-mounting via `udisksctl`. Ensure your user has mount permissions.
- **Slow first request**: Ollama loads models on first invocation (30–40 s cold start).
