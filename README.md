# Loom

Loom is a local-first content ingestion, contextual evaluation, and Obsidian vault integration assistant. It helps researchers, writers, and knowledge workers evaluate incoming web articles and YouTube transcripts against active Obsidian projects using semantic embeddings and AI synthesis.

---

## Architecture Overview

- **Ingestion Pipeline**: Accepts URLs (web pages and YouTube videos/shorts/embeds/live), extracts clean text (via Readability and official YouTube transcripts), summarizes content, and generates semantic vector embeddings using local Ollama (`bge-m3`).
- **Two-Phase Evaluator**:
  - **Step 1 (Spatial Filter)**: Computes cosine distance against the latest active project snapshot embeddings in PostgreSQL (`pgvector`).
  - **Step 2 (LLM Synthesis)**: Sends matched project context and article summaries to Google Gemini (`gemini-3.1-flash-lite`) or local Ollama with structured JSON schemas to determine verdict (`actionable`, `tentative`, or `irrelevant`).
- **Obsidian Vault Sync**: Watches configured Obsidian vaults (`Projects/` or `Proyectos/`), parses project notes and thesis, automatically snapshots changes, and writes accepted suggestions directly to the vault as markdown callouts.
- **Web UI & Dashboard**: Clean single-page application providing an Inbox, Triage feed, Project detail views, and Vault settings with live status indicators.

---

## Requirements

- **Node.js**: `>= 22.0.0`
- **PostgreSQL**: With `pgvector` extension enabled.
- **Ollama**: Local instance with the `bge-m3` embedding model installed:
  ```bash
  ollama pull bge-m3
  ```
- **Google Gemini API Key** (optional, recommended for fast structured evaluations):
  ```bash
  GEMINI_API_KEY=your_gemini_api_key
  ```

---

## Getting Started

### 1. Environment Configuration

Copy the example environment file or configure your `.env`:

```bash
cp .env.example .env
```

Key environment variables:
```env
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://loom:loompassword@localhost:5432/loomdb
OLLAMA_URL=http://127.0.0.1:11434
EMBED_MODEL=bge-m3
CHAT_MODEL=gemini-3.1-flash-lite
GEMINI_API_KEY=your_key_here
VAULT_PATH=C:/path/to/your/obsidian/vault
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Database Migration & Setup

Apply the Drizzle database migrations:
```bash
pnpm run db:migrate
```

To seed demo data:
```bash
pnpm run db:seed
```

### 4. Running the Application

For development with hot reload:
```bash
pnpm run dev
```

For production start:
```bash
pnpm start
```

Or on Windows:
```cmd
start.bat
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

---

## Demo Vault

A pre-configured Obsidian test vault is provided in `./demo_vault`. It contains example projects structured under `Projects/` with thesis files and research notes ready for live reconciliation.

---

## Quality & Tooling Scripts

- **Typecheck**:
  ```bash
  pnpm run typecheck
  ```
- **Lint**:
  ```bash
  pnpm run lint
  ```
- **Tests**:
  ```bash
  pnpm test
  ```
