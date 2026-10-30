# Goals and Context

Read this before any phase. It explains why the work exists and what "done" means.

## Purpose

Loom is a solo project and the owner's main portfolio piece for applied-AI / AI-engineer roles. The goal of this effort is a **clean, trustworthy, reproducible version** that a recruiter or engineer can run in minutes, whose claims are backed by evidence, and that the owner can present in a LinkedIn post about what was built and what was learned along the way.

The owner wants the honest story, including dead ends and bugs found, not a polished fiction.

## "Ready to publish" checklist

- README: 60-second pitch, demo video or GIF, architecture diagram, quickstart, and an honest limitations section.
- Setup: `.env.example`, documented prerequisites, predictable migrations, a demo vault, and a one-command start from a clean clone.
- CI green: typecheck, lint, unit and integration tests on every push.
- Evaluation report with real numbers (`evals/REPORT.md`), including a Gemini vs local Qwen comparison.
- Threat model (`docs/THREAT_MODEL.md`) and tests for the security cases it lists.
- No secrets in the tree or in git history; a license chosen; no personal paths or vault content.
- Documentation matches the implementation. No dead code, abandoned features, or unreferenced tables left over from earlier iterations.
- `docs/JOURNEY.md` is complete: decisions, dead ends, bugs found, cleanup done, before/after metrics.

## What Loom should demonstrate (to verify, not assume)

- LLM integration: Gemini, Ollama, structured output, provider fallback.
- RAG and retrieval: embeddings, pgvector/HNSW, project- and note-level matching.
- Backend engineering: TypeScript, Fastify, PostgreSQL, background workers, validated APIs.
- AI workflow design: multi-step evaluation, tentative promotions, context-aware re-evaluation, human approval.
- Reliability: snapshots, atomic writeback intent, queue processing, automated tests.

Caveat: this list comes from the architecture document, which describes intent. The audit verifies what the code really does.

## What is missing, in priority order

1. **Evaluation:** no labeled dataset or benchmark proving Loom picks the right projects and notes or writes useful suggestions. This is the centerpiece of the next phase.
2. **AI observability:** `llm_telemetry` records model, latency, and success only. Stage latency, retries, fallbacks, token usage, cost, and retrieval stats are missing.
3. **Reliability and safety proof:** CI, deterministic AI fixtures, failure-scenario tests, SSRF and path-traversal protection, prompt-injection resilience, and a threat model.
4. **Reproducibility and real use:** repeatable setup, a recorded demo, and a few real users running a defined workflow.

## Non-goals

- No rewrite in Python. The eval runner is TypeScript inside this repo; an optional Python analysis script over the results is fine.
- No LangChain/LangGraph, fine-tuning, or new frameworks added only to fill a CV.
- No new product features before the evaluation harness exists.
- No hosted public deployment is required. Loom is local-first; a clean local setup plus a recorded demo is enough.

## Honesty rules for the story

- Every number comes from a command in the repo that can be re-run, stored with the git SHA and configuration that produced it.
- Ground-truth labels for the eval dataset are made by the owner. The agent builds tooling and labeling templates but never decides what is "correct" (labels that merely agree with the model prove nothing).
- User-testing numbers count only real sessions with real people. Otherwise write "not measured".
- Limitations (for example, weaker local 7B quality) are stated, not hidden.
- When a finding embarrasses the project (a vulnerability, dead feature, wrong assumption), it goes into `docs/JOURNEY.md` as it happened. That is useful story material, not something to hide.
