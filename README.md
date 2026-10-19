# Rekindle

[![CI](https://github.com/Corcholog/rekindle/actions/workflows/ci.yml/badge.svg)](https://github.com/Corcholog/rekindle/actions/workflows/ci.yml)

**What you read rekindles what you stopped writing.**

Writing projects get set aside for weeks, and then you read something that connects to one of them without noticing. Rekindle is a **local-first** assistant that notices for you. You keep your projects as Markdown notes in an Obsidian vault and clip the articles and YouTube videos you read. Rekindle summarises each one, compares it with every project and note, and proposes a concrete action ("cite this in the research notes", "use this as a counter-argument"). Projects that have gone quiet are marked, and a suggestion that reaches one says so. Only the suggestions **you accept** are written to your vault.

| Light | Dark |
|---|---|
| ![Suggestions view in the light theme: projects with idle-time embers and a suggestion that rekindles a project idle for 61 days](docs/images/suggestions-light.png) | ![The same view in the dark theme](docs/images/suggestions-dark.png) |

*Screenshots from a real run on the English demo vault with local `qwen2.5:7b-instruct`, with note dates aged to show dormant projects. The project was called Loom until 2026-10-19.*

> Rekindle runs in **English or Spanish**: the interface, the suggestions and the notes it writes follow `LANGUAGE` (a fresh clone starts in English; change it any time in Settings). The model's instructions stay in Spanish, because that measured best ([Languages](#languages)). Code and developer documentation are in English.

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

- **Ingestion & Web Clipper**: Ingest links directly from the Web UI or via the **Manifest V3 Web Clipper extension** (`extension/`). The clipper supports offline queueing in `chrome.storage.local` with background auto-sync when Rekindle reconnects. Web pages (Readability) and YouTube (shorts/embed/live/youtu.be transcripts) are canonicalised, stripped of tracking params, and capped safely.
- **Hierarchical Evaluation**: Step 1 is a pgvector pre-filter checking both project snapshots and granular note snapshots (`project_note_snapshots`); step 2 is a structured-output LLM call with focal note context targeting specific files in your vault. Providers are tried in the order of `LLM_PROVIDERS` (default DeepSeek, then Gemini, then local Ollama `qwen2.5:7b-instruct`); a provider without a key is skipped and a failure moves to the next one.
- **Living Vault Sync & Staleness**: A watcher (3 s debounce) re-reads project notes recursively, updates immutable snapshots, and computes vector drift (`STALE_DRIFT_THRESHOLD = 0.04`). Stale suggestions are flagged with badges and can be re-evaluated context-aware against updated drafts.
- **Synergies & Consultor**:
  - **Cross-Project Thematic Synergies**: Discovers conceptual bridges between different projects via note-to-note vector distance and drafts a bridge note you can save to the vault.
  - **Archive & Vault Research Partner ("Consultor")**: Answers natural language research questions by reasoning across your entire saved library and all active Obsidian project notes simultaneously, citing sources as `[C1]` (library) and `[N1]` (notes). The cited cards are checked against the catalog; inline references in the answer text are not yet verified.
- **Explicit Writeback**: Accepting a suggestion appends a native Obsidian `> [!tip]` callout to `<project>/suggestions.md`. Pending, tentative, and discarded suggestions never touch the vault. Synergy notes and research briefs are saved only when you click **Save to Obsidian** (*Guardar en Obsidian*).
- **Dormant projects**: every project shows how long its notes have gone untouched (an ember that heats up with idle time); dormant projects with new suggestions are listed first, and a suggestion for a project idle 14 days or more is marked as rekindling it. The idle time comes from the notes' modification dates; Rekindle's own files never reset it.
- **Web UI** (React, TypeScript, Tailwind; light and dark themes; English and Spanish): 4 focused views:
  1. **Reading** (*Consumo*): Ingestion input card and chronological reading history feed.
  2. **Suggestions** (*Sugerencias*): Project-scoped triage with staleness pills, backlog synthesis, and accept/discard/reevaluate actions.
  3. **Consultant** (*Consultor*): Full-catalog research consultant with interactive prompt chips.
  4. **Settings** (*Configuración*): Vault directory configuration, languages, disk mount status, and forced rescan.

### Vault layout

```
<vault>/
  Projects/            (or Proyectos/)
    My_Project/
      ideas.md         ← note tagged #project (or frontmatter tags: [project])
      chapter1.md      ← any markdown note
      research/
        sources.md     ← recursive subdirectories are fully indexed
      suggestions.md   ← written by Rekindle, ignored when reading
```

Notes inside project folders are indexed recursively. No mandatory `project.md` file is required. Attachments and `.obsidian` configurations are safely ignored.

---

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

## Quick start

```bash
git clone https://github.com/Corcholog/rekindle.git && cd rekindle
corepack enable && pnpm install
./start.sh        # copies .env.example, starts Postgres, migrates, runs `pnpm preflight`, starts the server
```

Open <http://127.0.0.1:3000>. Until you set `VAULT_PATH`, Rekindle uses a synthetic demo vault in your language: [`demo_vault_en/`](demo_vault_en) (English, the default of a fresh clone) or [`demo_vault/`](demo_vault) (Spanish, with `LANGUAGE=es`). Each has 4 projects and 15 notes. Paste the links from [`demo_vault_en/ARTICLES.md`](demo_vault_en/ARTICLES.md) (or [`demo_vault/ARTICULOS_DEMO.md`](demo_vault/ARTICULOS_DEMO.md)) into **Reading** (**Consumo**), wait for the summaries, and open **Suggestions** (**Sugerencias**).

`pnpm preflight` is the same check `start.sh` runs: it verifies Node, `.env`, Postgres, migrations, Ollama and its models, the vault, and which LLM providers are active, and prints the command that fixes each problem. `start.bat` does the same on Windows but **has not been tested** on a real Windows machine.

**What a first run looked like** (a fresh clone, no cloud keys, so everything on local `qwen2.5:7b-instruct`; one run per language on one Linux machine, not a benchmark):

| Demo vault | Suggestions from the 9 listed articles | Control articles | First suggestion after the first clip |
|---|---|---|---|
| English (`demo_vault_en`) | 1 `actionable`, 7 `tentative` | nothing | 173 s |
| Spanish (`demo_vault`) | 1 `actionable`, 5 `tentative` | nothing | 201 s |

Some `tentative` links are weak (in the English run the attention-economy article was marked tentative for the lighthouse novel too). Other models and machines will differ; the quality numbers that matter are under [Evaluation](#evaluation).

---

## Getting started in detail

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
start.bat                  # checks Docker/Ollama, migrates, opens browser and launches dev
```

Open <http://127.0.0.1:3000>. Without `VAULT_PATH` the demo vault in [`demo_vault/`](demo_vault) is used.

### 4. Browser Extension (Optional)

1. Open Chrome/Brave/Edge and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in upper right).
3. Click **Load unpacked** and select the [`extension/`](extension) folder from this repository.
4. Pin the **Rekindle Web Clipper** icon for 1-click clipping from any webpage.

---

## Privacy note

Embeddings are always computed locally. If `GEMINI_API_KEY` is set, the following leaves your machine for Google's API:

- the article text (up to 50,000 characters) for summarisation;
- for each evaluation and re-evaluation, **up to 15,000 characters of your project notes**, plus the article summary;
- for each Consultor question, **the summaries of every ready item in your library and a snippet of every active project note**;
- for synergies, note snippets from both projects; for backlog synthesis, your accepted suggestions plus up to 10,000 characters of project notes.

With a `DEEPSEEK_API_KEY` set (the default chain is `deepseek,gemini,ollama`), the same content goes to DeepSeek first (a China-hosted API) and to Gemini only if DeepSeek fails; without that key DeepSeek is skipped. Leave both keys empty and every LLM call runs on local Ollama. Rekindle still contacts the sites you ingest (and YouTube for transcripts). The web UI's fonts are bundled, so opening it contacts nothing outside your machine.

---

## Languages

Three choices, because they matter for different reasons:

| Setting | What it controls | Why it is separate |
|---|---|---|
| Interface language | Every label, button and message in the web UI | Stored per browser; defaults to `LANGUAGE` |
| `OUTPUT_LANGUAGE` | What the model writes for you to read: reasoning, suggested actions, Consultor answers, synergies, briefs, and the callouts written to your vault | What you read should be in your language |
| `NOTES_LANGUAGE` | The language article summaries are written in | The summary is what gets embedded and compared with your notes, so it should be in the notes' language whatever the article's language |

The language of the model's **instructions** is not a setting: it stays Spanish because that measured best. Measured on the labeled evaluation set (DeepSeek Flash, the 3 closest projects per article, the same 47 articles and 376 labeled pairs as below, with the labels as revised on 2026-10-19; one run each; a repeat of the baseline and the label revision are described under [Evaluation](#evaluation)):

| Change from the Spanish baseline | Triage macro-F1 | `actionable` precision / found | Connections found / invented | Retrieval recall@3 / unrelated articles that still retrieve a project |
|---|---|---|---|---|
| Baseline: Spanish instructions, summaries and output | 0.77 | 100% / 27 of 35 | 46 of 56 / 19 | 91% / 94% |
| E1: English output | 0.75 | 100% / 27 of 35 | 45 of 56 / 20 | 91% / 94% (same summaries) |
| E2: English summaries compared with the Spanish notes | 0.71 | 96% / 24 of 35 | 42 of 56 / 25 | 84% / 82% |
| E3: English instructions | 0.72 | 100% / 22 of 35 | 43 of 56 / 10 | 91% / 94% (same summaries) |

What this supports: English output costs nothing measurable (the actionable verdicts were identical), so it is safe to offer. English instructions made the model more reluctant to call an article actionable, so instructions stay Spanish. Summaries in a different language from the notes lose relevant matches (and also filter more, since cross-language distances are larger), so summaries follow the notes. These are single runs on one person's labels; the English-output and English-notes combinations other than these three were **not measured**, and an English vault with English labels was **not measured**. Full tables: [`evals/REPORT.md`](evals/REPORT.md).

---

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
| `pnpm usertest:stats` | Counts only (acceptance rate, discard reasons, time to first suggestion) for [user-test sessions](docs/USER_TEST.md) |
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
| [docs/DEMO.md](docs/DEMO.md) | Script and shot list for the demo recording |
| [docs/USER_TEST.md](docs/USER_TEST.md) | Workflow for testing Rekindle with real people, and what is recorded |
| [docs/JOURNEY.md](docs/JOURNEY.md) | Build log: decisions, dead ends, bugs found and fixed |

---

## Evaluation

`pnpm eval` runs Rekindle's real retrieval and triage against articles and projects labeled by a person (see [`evals/README.md`](evals/README.md)); the full tables are in [`evals/REPORT.md`](evals/REPORT.md). Latest run, with the current setup (the 3 closest projects per article reach the LLM, Phase 5 prompts): one labeler (the project owner), 47 articles × 8 projects = 376 labeled pairs (35 actionable, 21 tentative, 320 irrelevant), each provider alone with no fallback, identical summaries and retrieval:

| | Gemini 3.1 Flash Lite | **DeepSeek Flash** (thinking off) | DeepSeek Flash (thinking on) | Qwen 2.5 7B (local) |
|---|---|---|---|---|
| Triage macro-F1 | 0.69 | **0.77** | 0.71 | 0.58 |
| `actionable` precision / recall | 64% / 91% | **100% / 77%** | 79% / 89% | 100% / 34% |
| Connections found (of 56) / invented | 49 / 25 | 46 / 19 | 49 / 26 | 32 / 9 |
| Latency p50 / p95 | 4.4 / 11.7 s | **2.3 / 4.4 s** | 4.1 / 8.4 s | 3.8 / 8.3 s |
| Tokens per triage call: input (cached) / output (thinking) | not measured | 2,170 (1,976) / 281 (0) | 2,195 (1,600) / 638 (259) | not measured |
| Estimated cost of the 118 calls | free tier | $0.024 | $0.056 | $0 |

**Connections found** treats `actionable` and `tentative` as one answer, "this article connects to this project": calling an actionable pair tentative, or the reverse, still shows you the connection, so only a lost connection or an invented one counts as an error. 7 of the 56 labeled connections never reach the model because of the top-3 cutoff, so 49 is the most any model can find here; *invented* counts pairs labeled irrelevant that the model called actionable or tentative.

DeepSeek with thinking off has the best macro-F1 and is the default (`deepseek,gemini,ollama`, thinking off); it also led when every project within the distance threshold reached the LLM and with the earlier prompts and labels (macro-F1 0.74 vs 0.56 and 0.61, in [`docs/JOURNEY.md`](docs/JOURNEY.md)). Thinking on trades the other way: it finds every connection that reaches it and 4 more actionable pairs, but invents 7 more connections, calls 8 pairs actionable that are not, and takes nearly twice the latency and more than twice the output tokens. Gemini behaves like thinking on, with more false actionables.

**The labels were revised after seeing these answers.** On 2026-10-19 the owner read the pairs thinking on called actionable and changed 7 labels, every one toward thinking on's answer (2 tentative → actionable, 2 irrelevant → actionable, 3 irrelevant → tentative). All the numbers in this section use the revised labels, rescored from the recorded answers with `pnpm eval rescore` (no new model calls); this favors thinking on. Before the revision thinking on scored macro-F1 0.69 against 0.78.

Recall counts the relevant pairs that the top-3 cutoff never sends to the LLM as misses. These numbers come from a small, single-labeler dataset: treat gaps of a few points as noise. Run-to-run variance is **not measured** beyond a single repeat: repeating the thinking-off run on 2026-10-19 gave macro-F1 0.75 against 0.77, 25 actionable pairs found instead of 27 with 1 false actionable instead of 0, and 47 connections instead of 46. Retrieval at the 0.6 distance threshold finds 91% of the relevant projects but lets 94% of unrelated articles through (precision@3 59%). Suggestion quality (usefulness, actionability) is **not measured**.

**Tokens and cost.** The thinking-off token and cost figures come from that repeat run, because the first one did not record cache hits. Cost is estimated from the tokens DeepSeek reports and its list prices: cached input costs 2% of uncached input, and both runs were off-peak (half price). Before 2026-10-19 the harness priced every token as uncached and peak-hour, so it overstated cost: its estimates for the DeepSeek runs up to then add up to $0.69, while DeepSeek billed $0.25 for all use up to then (the first run, estimated at $0.18, was billed $0.07; figures from the owner's DeepSeek dashboard, not reproducible from this repo). The new estimates have **not** been checked against the bill yet.

**Real-user testing: not measured.** The workflow and the counts to record are defined in [`docs/USER_TEST.md`](docs/USER_TEST.md); no session has been run yet.

## Observability

Every ingestion starts a trace that follows the article through fetch, extraction, summary, embedding, retrieval and triage to its suggestions. Each stage and each LLM attempt (provider, retries, fallbacks, errors, tokens, estimated cost) is stored in Postgres, and `pnpm telemetry:report` and `pnpm telemetry:trace` read it back. Logs and telemetry hold IDs, counts, lengths, hashes and durations only: no note text, article text, prompt, model output or URL (`tests/pipeline_trace.test.ts` checks this with planted sentinel strings). Production latency, failure and cost figures on the owner's real use are **not measured** yet. See [ARCHITECTURE §16](docs/ARCHITECTURE.md#16-observability-srcobservability).

## Security model

Rekindle is a single-user, local-only tool:

- **Network:** the API has no login. It only binds to loopback (`HOST` must be `127.0.0.1`, `localhost` or `::1`), and it rejects requests addressed to any other host name, which blocks DNS rebinding. It also rejects state-changing requests from other web origins. The browser extension may only call `/api/ingest`.
- **Your vault:** Rekindle writes only when you act. **Accept** appends a callout to `<project>/suggestions.md`; **Save to Obsidian** saves a synergy note or research brief as a new file and never overwrites one. Model text is sanitized first: code blocks, embeds, HTML and fake callouts are neutralized.
- **Ingestion:** only public `http(s)` pages are fetched. Every resolved IP address and every redirect is checked, and pages are capped at 5 MB.
- **Prompt injection:** pages and notes are untrusted. Their text is delimited so it cannot break out of its block, every prompt says delimited text is data, and the limits that matter are enforced in code: a suggestion can only point at an existing note of its project, and nothing reaches the vault unless you accept it, sanitized.

The full list of threats, mitigations, tests and residual risks is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Known limitations

- **The 0.6 distance threshold barely filters.** On the evaluation set 94% of unrelated articles still retrieved a project, so every article costs about 4.6 LLM calls. [`evals/SWEEP.md`](evals/SWEEP.md) compares cutoffs: only the 3 closest projects now reach the LLM (`TOP_K_PROJECTS_LIMIT = 3`), which cut calls by 45% and keeps 86% of the relevant pairs, but 1 in 8 relevant pairs is never evaluated.
- **`tentative` judgements are weak for every model tried.** `tentative` F1 is 0.28–0.48 (a small sample: 21 pairs). Counted as connections, together with `actionable`, the models find 32–49 of the 56 labeled connections.
- **Suggestion quality (usefulness, actionability) is not measured.** Only verdicts are scored, against one person's labels. Whether a suggestion names the note the owner would have picked is **not measured**: the labeled projects' notes were not good enough to judge it ([`evals/README.md`](evals/README.md)).
- **A failed evaluation is invisible in the UI.** If the LLM fails while evaluating an article for a project, the job is retried three times (after 30 s, 60 s and 120 s); after that the pair waits until the project changes. Only `pnpm telemetry:report` shows the failure.
- **The Consultor sends your whole library in one prompt.** Large libraries can exceed the local model's context window.
- **Synergies may include deleted notes**, because they compare notes from older project snapshots too.
- **Idle time comes from file modification dates.** Copying or syncing a vault in a way that rewrites the dates makes every project look freshly edited (a fresh clone of the demo vault shows 0 days), and a project's idle time is unknown until Rekindle has read it once.
- **The extension can send a queued clip twice** when two sync triggers fire at once. Re-ingesting is harmless; it no longer creates duplicate suggestions.

---

## Troubleshooting

- **Project never matches anything**: check Ollama is running with `bge-m3` (a failed embedding is retried on the next change/boot/rescan, nothing is stored meanwhile). Use *Settings → Rescan*.
- **`ECONNREFUSED 127.0.0.1:11434`**: start Ollama (`ollama serve`).
- **Ingestion fails with "Unsupported content type"**: only HTML/text pages are supported (no binary PDFs).
- **Secondary Linux drive not detected**: if your vault is on an NTFS/removable partition (`/run/media`), Rekindle attempts auto-mounting via `udisksctl`. Ensure your user has mount permissions.
- **Slow first request**: Ollama loads models on first invocation (30–40 s cold start).

---

## License and citation

Rekindle is released under the [Apache License 2.0](LICENSE). You may use, modify and redistribute it, including commercially; redistributions and derivative works must keep the [`NOTICE`](NOTICE) file, which credits the author. To cite Rekindle, use GitHub's *Cite this repository* button or [`CITATION.cff`](CITATION.cff).

Built by Giorgio Ivan Loguercio ([GitHub](https://github.com/Corcholog) · [LinkedIn](https://www.linkedin.com/in/corcho-log/)).
