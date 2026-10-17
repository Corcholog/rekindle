# Loom — Journey Log

A factual record of what was decided, tried, broken, and fixed while taking Loom from a working prototype to a publishable version. It is the source material for the README story and the LinkedIn post.

**How to use it:** after each phase (and after any notable discovery), add an entry. Facts only: what happened, what evidence supports it (commit, test, file, report), and what was learned. No invented metrics; unmeasured things say "not measured". Include failures and dead ends.

## Starting point

- Code state at the start of this effort: git `master` @ `1cc4432` plus working-tree refinements.
- Verification at the start: `tsc --noEmit` clean, `eslint .` clean, 9 offline unit tests passing. Integration and e2e tests require Docker/Testcontainers.
- Known gaps at the start: no evaluation dataset or metrics, minimal telemetry (model, latency, success), no CI, setup requires Docker + Ollama + Postgres knowledge.

## Phase log

<!-- Copy this block for each entry -->
### YYYY-MM-DD — Phase N: short title
- **Context:** what we were trying to do and why.
- **What happened:** the decision, change, or discovery.
- **Alternatives considered:** what else was an option and why it was not chosen.
- **Evidence:** commit hashes, test names, report paths.
- **Outcome / lesson:** what changed and what was learned.

## Bugs and vulnerabilities found

| ID | What was wrong | How it was found | Severity | Fixed in | Test that proves the fix |
|---|---|---|---|---|---|

## Dead code and legacy removed

| Item | Why it was there | Why it was removed | Commit |
|---|---|---|---|

## Metrics, before and after

| Date | Change | Metric | Before | After | Command / report |
|---|---|---|---|---|---|

## Dead ends and things that did not work

-
