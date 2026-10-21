# Setup and reference

Everything the [README](../README.md) leaves out: requirements, configuration, commands, the HTTP API, languages, observability and troubleshooting. The design and internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

| You need | Why |
|---|---|
| **Node.js** `>= 22` | runs the server (CI uses 22; developed on 24) |
| **pnpm** 12 | `corepack enable` installs the version pinned in `package.json` |
| **Docker** | PostgreSQL 16 with `pgvector` (`docker compose up -d postgres`); also needed by `pnpm test` |
| **Ollama** | local embeddings and the local chat model; about 6 GB of downloads |
| *Optional:* DeepSeek or Gemini API key | faster, better-scored triage. See the privacy note below |

```bash
ollama pull bge-m3              # embeddings (required, 1024-d, always local)
ollama pull qwen2.5:7b-instruct # local LLM (used when no cloud key is set, or as fallback)
```

## Install and configure in detail

### 1. Configure (`start.sh` does this for you)

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Must be loopback (`127.0.0.1`, `localhost`, `::1`); the API has no authentication. |
| `PORT` | `3000` | HTTP port. |
| `DATABASE_URL` | `postgres://rekindle:rekindlepassword@localhost:5432/rekindledb` | Matches `docker-compose.yml`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `EMBED_MODEL` | `bge-m3` | Embedding model. The DB column is `vector(1024)`, so the model must output 1024 dims. |
| `CHAT_MODEL` | `gemini-3.1-flash-lite` | **Gemini** model name. (The Ollama chat model is fixed to `qwen2.5:7b-instruct`.) |
| `GEMINI_MODEL` | – | Optional override of `CHAT_MODEL`. |
| `LLM_PROVIDERS` | `deepseek,gemini,ollama` | Order in which LLM providers are tried (`deepseek`, `gemini`, `ollama`). Providers without a key are skipped; malformed output is retried once, then the next provider is used. |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | – / `deepseek-flash` | Enables DeepSeek when listed in `LLM_PROVIDERS`. Thinking mode is requested off. |
| `GEMINI_API_KEY` | – | Enables Gemini. Leave empty for 100% local operation. |
| `VAULT_PATH` | `./demo_vault_en` or `./demo_vault` (via `pnpm start/dev`, by notes language) | Obsidian vault root. Can also be changed in the UI (it rewrites this line in `.env`). |
| `LANGUAGE` | `en` in `.env.example`, `es` if unset | Interface default, language of suggestions and answers, and language of your notes. See [Languages](#languages). |
| `OUTPUT_LANGUAGE` / `NOTES_LANGUAGE` | `LANGUAGE` | Override either half of the preset (also editable in Settings). |
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
./start.sh                 # or: pnpm build:web && pnpm preflight && pnpm serve

# On Windows:
start.bat                  # the same steps as start.sh (not tested on a real Windows machine)
```

Open <http://127.0.0.1:3000>. Without `VAULT_PATH` the demo vault in your language is used: [`demo_vault_en/`](../demo_vault_en) (English, the default) or [`demo_vault/`](../demo_vault) (Spanish).

### 4. Browser Extension (Optional)

1. Open Chrome/Brave/Edge and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in upper right).
3. Click **Load unpacked** and select the [`extension/`](../extension) folder from this repository.
4. Pin the **Rekindle Clipper** icon to clip any page in one click (it also offers a right-click menu, and queues clips while Rekindle is offline).

## Languages

Three choices, because they matter for different reasons:

| Setting | What it controls | Why it is separate |
|---|---|---|
| Interface language | Every label, button and message in the web UI | Stored per browser; defaults to `LANGUAGE` |
| `OUTPUT_LANGUAGE` | What the model writes for you to read: reasoning, suggested actions, Consultor answers, synergies, briefs, and the callouts written to your vault | What you read should be in your language |
| `NOTES_LANGUAGE` | The language article summaries are written in | The summary is what gets embedded and compared with your notes, so it should be in the notes' language whatever the article's language |

The language of the model's **instructions** is not a setting: it stays Spanish because that measured best on the evaluation set ([EVALUATION.md](EVALUATION.md#languages)).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Rebuilds the web UI on every change and restarts the server on every change (same origin as production) |
| `pnpm build:web` | Builds the React UI into `web/dist`, which the server serves (`start.sh` does it for you) |
| `pnpm serve` | Starts the server without rebuilding |
| `pnpm build:icons` | Renders the logo (`web/public/favicon.svg`) into the extension icons |
| `pnpm typecheck` | `tsc --noEmit` for the server and for `web/` |
| `pnpm lint` | ESLint (`@typescript-eslint`) |
| `pnpm test` | Vitest. Needs Docker: integration tests start throwaway pgvector databases with Testcontainers. No Ollama or API key is needed: a deterministic fake stands in for the models. CI runs this on every push. |
| `pnpm test:coverage` | Same, with v8 coverage for `src/` |
| `REKINDLE_LIVE_TESTS=1 pnpm test` | Also runs the opt-in live checks against local Ollama and the real DeepSeek and Gemini APIs (keys from `.env`); by default tests never reach a model |
| `pnpm exec vitest run tests/parser.test.ts tests/youtube_ingest.test.ts` | Offline unit tests only |
| `pnpm preflight` | Checks the install (Node, Postgres, migrations, Ollama models, vault, active providers) and prints the fix for each problem |
| `pnpm run db:generate` | Generate a Drizzle migration after editing `src/db/schema.ts` |
| `pnpm run db:migrate` | Apply migrations |
| `pnpm run db:reset` | ⚠️ Drops `public`, `drizzle` and `pgboss` schemas and re-migrates (`reset_db.sh` / `reset_db.bat`) |
| `pnpm telemetry:report --since 7d` | Per-stage latency, LLM failure / fallback / malformed rates, tokens and estimated cost for a period |
| `pnpm telemetry:trace <suggestionId\|contentId>` | Follows a suggestion back to its content, the retrieval step that selected it, every stage and every LLM attempt |
| `pnpm telemetry:prune --older-than 90d` | ⚠️ Deletes telemetry rows and pipeline events older than the given age (never runs automatically) |

## HTTP API summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ingest` | `POST` | Queue a URL (`202` new, `200` re-queued) |
| `/api/contents`, `/api/contents/:id` | `GET` | Reading feed, status indicators, and content details |
| `/api/library/consult` | `POST` | Research Partner over the library items and notes closest to the question |
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

Full contracts, schemas, and semantics are in [ARCHITECTURE.md](ARCHITECTURE.md#12-complete-http-api-reference).

## Observability

Every ingestion starts a trace that follows the article through fetch, extraction, summary, embedding, retrieval and triage to its suggestions. Each stage and each LLM attempt (provider, retries, fallbacks, errors, tokens, estimated cost) is stored in Postgres, and `pnpm telemetry:report` and `pnpm telemetry:trace` read it back. Logs and telemetry hold IDs, counts, lengths, hashes and durations only: no note text, article text, prompt, model output or URL (`tests/pipeline_trace.test.ts` checks this with planted sentinel strings). Production latency, failure and cost figures on the owner's real use are **not measured** yet. See [ARCHITECTURE §16](ARCHITECTURE.md#16-observability-srcobservability).

## Troubleshooting

- **Project never matches anything**: check Ollama is running with `bge-m3` (a failed embedding is retried on the next change/boot/rescan, nothing is stored meanwhile). Use *Settings → Rescan*.
- **`ECONNREFUSED 127.0.0.1:11434`**: start Ollama (`ollama serve`).
- **Ingestion fails with "Unsupported content type"**: only HTML/text pages are supported (no binary PDFs).
- **Secondary Linux drive not detected**: if your vault is on an NTFS/removable partition (`/run/media`), Rekindle attempts auto-mounting via `udisksctl`. Ensure your user has mount permissions.
- **Slow first request**: Ollama loads models on first invocation (30–40 s cold start).
