# Demo script

A 2.5 to 3 minute screen recording that shows the whole loop on a synthetic demo vault, with no cloud key. For an English audience use `LANGUAGE=en` and `demo_vault_en/` (articles in `demo_vault_en/ARTICLES.md`). The lines to say are written in Spanish; translate them for an English recording (the views are Reading, Suggestions, Consultant and Settings). The recording is made by the owner; this file is the script and the checklist. Nothing here has been recorded yet.

## Before recording

- Fresh state: `pnpm run db:reset` (drops the dev database; it needs the owner's approval each time) or a separate database through `DATABASE_URL`. Use a throwaway database, never the one with real data.
- `.env`: `VAULT_PATH` unset (uses `demo_vault_en/` with `LANGUAGE=en`, `demo_vault/` with `LANGUAGE=es`), both cloud keys empty so the footage honestly says "100% local". If a cloud model is wanted for speed, say so on screen.
- Delete any `demo_vault*/**/suggestions.md` left from a rehearsal (they are git-ignored).
- Terminal: `./start.sh`, and wait for `Ready: all required checks passed`. Warm the models first by clipping one throwaway article, otherwise the first request takes 30 to 40 seconds.
- Browser: one window at 1280x720, Obsidian open on `demo_vault` in a second window, the extension pinned.
- Hide bookmarks and other tabs.

## Shot list

| # | Time | Screen | Say (in the language of the recording) | Shows |
|---|---|---|---|---|
| 1 | 0:00 | Obsidian with the four project folders open | "Estos son mis proyectos de escritura: una novela, un ensayo, un juego de mesa y un podcast." | The vault is plain Markdown |
| 2 | 0:15 | Terminal running `./start.sh`, ending in the preflight list | "Un solo comando: levanta la base de datos, revisa Ollama y los modelos, y arranca." | One-command start and the preflight |
| 3 | 0:30 | Loom at **Configuración**: vault path and four projects | "Loom lee las notas y calcula embeddings locales." | I3: embeddings stay local |
| 4 | 0:45 | Browser on the Wikipedia article *Faro*, click the extension | "Leo un artículo y lo guardo con la extensión." | Web clipper |
| 5 | 1:00 | **Consumo**: the article moving from pending to ready, then the summary | "Loom lo resume y lo compara con cada proyecto." | Ingestion pipeline |
| 6 | 1:20 | **Sugerencias** on the lighthouse project: the suggestion, its reasoning and the target note | "Propone una acción concreta y explica por qué. Nada se escribe todavía." | Human in the loop, I1 |
| 7 | 1:45 | Obsidian: no `suggestions.md` yet | "El vault sigue intacto." | I1 |
| 8 | 1:55 | Back in Loom: choose **Aceptar** (and on another card pick a reason and **Descartar**) | "Acepto una y descarto otra indicando el motivo." | Accept and discard reasons |
| 9 | 2:10 | Obsidian: the new callout in `suggestions.md` | "Aparece un callout con la acción, la observación y la fuente." | Explicit writeback |
| 10 | 2:25 | Terminal: `pnpm telemetry:report` | "Y puedo ver cada llamada al modelo: latencia, fallos y coste." | Observability |
| 11 | 2:40 | `evals/REPORT.md` table | "Mido los modelos contra etiquetas mías. Son pocos datos y una sola persona, y lo digo en el informe." | Honest evaluation |

## What not to claim on camera

- Do not give speeds or accuracy numbers other than the ones in the README, and quote them with their caveat (one labeler, small sample).
- Do not call the suggestions "good" or "useful": usefulness is not measured.
- Do not show `.env`, a terminal with exported keys, or the real vault.
- If a suggestion is `tentative` instead of `actionable` on the day, show it as it is. A first run on local `qwen2.5:7b-instruct` gave 1 `actionable` and 5 `tentative` results for the nine demo articles.

## Rehearsal checklist

- [ ] `pnpm preflight` is green with the cloud keys empty.
- [ ] All links in `demo_vault/ARTICULOS_DEMO.md` still load.
- [ ] The lighthouse article gives a suggestion before recording; if not, pick another from the list rather than editing the vault to force it.
- [ ] Total length under 3 minutes; the model wait in shots 5 and 6 is cut or sped up, and the video description says so.
