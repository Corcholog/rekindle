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
