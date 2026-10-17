# ADR 001: Decisiones de Arquitectura A1-A10

## Contexto
El SDD del proyecto Loom ha sido refinado con 10 ajustes (A1-A10). Este documento sirve como borrador para registrar estas decisiones.

## Decisiones

### A1: Hash Canónico
- **Decisión:** El `TreeHash` de un proyecto se calculará como `SHA256(concatenación de hojas ordenadas)`. Cada hoja es `SHA256(ruta relativa normalizada + contenido normalizado sin BOM ni CRLF)`. 
- **Exclusiones:** `suggestions.md` y carpetas ocultas (`.obsidian`, `.trash`).

### A2: Canonicalización de URL
- **Decisión:** Antes del UNIQUE, se eliminarán parámetros de rastreo (`utm_*`), fragmentos (`#`), se unificarán dominios de YouTube (`youtu.be` a `watch?v=`), y se normalizará la barra final.

### A3: Idempotencia vs Re-consumo
- **Decisión:** Clave única en `evaluations`: `UNIQUE(content_id, project_snapshot_id, consumption_seq)`.

### A4: Gating Snapshot -> Evaluación
- **Decisión:** El snapshot se crea de forma inmutable siempre. La evaluación se encola solo si existe una ventana de quietud o un drift de embedding suficiente. Se usará `singletonKey` en pg-boss por proyecto.

### A5: Thesis Text
- **Decisión:** `thesis_text` y su embedding serán `NULL` hasta que un job de enriquecimiento posterior lo complete.

### A6: Contrato Triage -> Verdict
- **Decisión:** Triage devuelve un JSON. Los veredictos mapean a:
  - `irrelevant` (no avanza a Capa 3)
  - `tentative` (opcional: a decidir si avanza a Capa 3, propuesta inicial: NO)
  - `actionable` (avanza a Capa 3)

### A7: Telemetría Completa
- **Decisión:** Se registrará cada llamada (local o cloud) con tokens, ms, costo, y modelo.

### A8: Writeback Seguro
- **Decisión:** `suggestions.md` debe excluirse del watcher/hash. El append usará un marcador idempotente `%% sug:<uuid> %%` y se escaparán los saltos de línea con `> `.

### A9: Egreso a Cloud (Privacidad)
- **Decisión:** La Capa 3 (Gemini) solo recibe el texto de la tesis, títulos de notas y el resumen del contenido. NUNCA borradores completos del usuario.

### A10: Stack y Versiones
- **Decisión:** Node 24 LTS, pnpm, TS strict, PostgreSQL 16 + pgvector, pg-boss, chokidar v4, `@huggingface/transformers` ONNX CPU int8, Ollama, Google Gen AI SDK, Vite + React.

## Consecuencias
- Quedan fijadas las reglas de validación y la frontera de seguridad con el vault.

---

## Addendum (2026-10): estado real de implementación

Contrastado contra el código en `master` (`855e4f6`). Este ADR se escribió como borrador de diseño; varias decisiones se implementaron de forma distinta o no se implementaron.

| ID | Estado | Realidad actual |
|---|---|---|
| A1 Hash canónico | 🟡 Parcial | `src/vault/hash.ts`: SHA-256 sobre los `*.md` del **primer nivel** de la carpeta del proyecto (nombre de archivo + SHA-256 del contenido, en streaming). Excluye `suggestions.md`. **No** normaliza BOM/CRLF, no usa rutas relativas ni recorre subcarpetas; las carpetas ocultas quedan fuera porque no se leen subcarpetas. |
| A2 Canonicalización de URL | ✅ | `canonicalizeUrl` (`ingestionWorker.ts`): quita `utm_*`, `fbclid`, `gclid`, `ref`, fragmentos y barra final; unifica `youtu.be`, `/shorts/`, `/embed/`, `/live/` a `watch?v=`. No reordena parámetros de consulta. |
| A3 Idempotencia vs re-consumo | ✅ | `UNIQUE(content_id, project_snapshot_id, consumption_seq)`; `consumption_seq` se incrementa al re-ingestar la misma URL. |
| A4 Gating Snapshot → Evaluación | ❌ No implementado | Cada snapshot nuevo encola de inmediato la evaluación retrospectiva de contenidos sin evaluar. Solo existe el debounce de 3 s del watcher. No hay umbral de *drift* de embedding. |
| A5 `thesis_text` NULL hasta enriquecer | ❌ No implementado | La tesis se extrae directamente de las notas (hasta 4000 caracteres) al crear el snapshot. |
| A6 Contrato Triage → Verdict | 🟡 Distinto | Una sola llamada LLM devuelve veredicto + acción (`unifiedEvaluationSchema`). `tentative` **no** avanza a acción, pero se muestra al usuario en la pestaña *Tentativas*. |
| A7 Telemetría completa | 🟡 Parcial | Solo se registra el componente `triage` (modelo y latencia). Sin tokens ni costo; no se registran fallos. |
| A8 Writeback seguro | 🟡 Parcial | `suggestions.md` excluido del watcher y del hash; saltos de línea escapados con `> `. **No** se usa el marcador `%% sug:<uuid> %%`: la idempotencia depende del flag `written_to_vault` (reclamado atómicamente en la escritura individual). |
| A9 Egreso a Cloud | ❌ Divergente | Con `GEMINI_API_KEY`, el evaluador envía la tesis **y hasta 15 000 caracteres de contenido de las notas**, y la ingesta envía hasta 50 000 caracteres del artículo. Debe decidirse si se acepta o se restringe. |
| A10 Stack | 🟡 Distinto | Node `>=22` (no 24), pnpm, TS strict, PostgreSQL 16 + pgvector, pg-boss, chokidar v5, Ollama, Google Gen AI SDK. **Sin** Vite/React (UI en JS vanilla) y **sin** `@huggingface/transformers` en runtime (ver ADR 002). |

Ver también `003-endurecimiento-post-revision.md`.

## Update (2026-10-17, Phase 0 audit and Phase 1 cleanup)

- **A1:** the hash and the reconciler are now **recursive** over the project folder (hidden entries and `suggestions.md` excluded). BOM/CRLF normalization is still not done.
- **A3:** the owner decided that **re-ingesting the same canonical URL must not create new evaluations or suggestions** (invariant I6 in `CLAUDE.md`). Since Phase 2, a known URL is not re-queued (unless its ingest failed) and `consumption_seq` is no longer incremented (`tests/reingest_idempotency.test.ts`).
- **A8:** since Phase 2, each callout carries a hidden `%% loom:<id> %%` marker, which recovery uses to avoid duplicates after a crash (`tests/writeback_recovery.test.ts`).
- **A9:** the current list of what is sent to Gemini is in the README "Privacy note" and in `docs/ARCHITECTURE.md` §15.
