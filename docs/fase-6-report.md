# Reporte de Fase 6 (Ciclo de Vida de Sugerencias & Vault Updater)

## A. Qué se implementó
1. **API de Ciclo de Vida y Triaje de Sugerencias:**
   - `GET /api/projects` y `GET /api/projects/:id`: Consulta de proyectos sincronizados con su tesis activa, métricas y contadores de sugerencias agrupados por estado (`pending`, `accepted`, `discarded`, `total`).
   - `GET /api/suggestions`: Listado paginado de sugerencias con filtros por proyecto (`projectId`) y estado (`status`), incluyendo metadatos de la fuente y de la evaluación.
   - `GET /api/suggestions/:id`: Detalle enriquecido con el resumen del contenido original, el veredicto de triaje, nivel de confianza y razonamiento del LLM.
   - `PATCH /api/suggestions/:id`: Endpoint de resolución para transicionar el estado de una sugerencia (`accepted` o `discarded`), registrando fecha de resolución (`resolvedAt`) y notas o feedback opcionales del usuario (`userFeedback`). Protegido con rechazo HTTP 409 si la sugerencia ya fue resuelta previamente.

2. **Política de Escritura Gated (Accept-Only Callouts en Obsidian):**
   - **Evolución de diseño fundamental:** Se descartó la inyección automática preliminar de sugerencias en formato checklist (`- [ ]`) al generarse, ya que contaminaba las notas del usuario con ideas pendientes de revisión.
   - En su lugar, se implementó la política estricta de **escritura condicionada a la aceptación**: las sugerencias pendientes o descartadas **nunca tocan el Vault**.
   - Cuando el usuario acepta una sugerencia, `writeAcceptedSuggestionToVault` inyecta atómicamente un bloque Callout nativo de Obsidian en `suggestions.md` dentro de la carpeta del proyecto:
     ```markdown
     > [!tip] Sugerencia Aceptada: CITA DE EVIDENCIA (13/10/2026)
     > **Acción:** Citar este artículo en la sección de arquitectura del proyecto.
     > **Observación:** El artículo valida la elección de Pub/Sub para agentes.
     > **Fuente:** [Título Fuente](https://...)
     > **Feedback:** Excelente referencia para fundamentar el broker.
     ```
   - Si la sugerencia se descarta (`discarded`), el estado se persiste en PostgreSQL pero el Vault permanece intacto.
   - Idempotencia total: La bandera `writtenToVault = true` y los chequeos atómicos evitan duplicación de bloques ante reintentos.

3. **Mecanismo de Recuperación Asíncrono (`src/vault/updater.ts` & `src/workers/vaultWorker.ts`):**
   - La función `syncProjectSuggestions` y la cola `sync_suggestions` de `pg-boss` actúan como camino de recuperación (*recovery path*) ante posibles caídas transitorias de disco o cambios de configuración, sincronizando en bloque todas las sugerencias aceptadas pendientes de escritura.

## B. Evidencia y Pruebas
- **Suite de Integración Automatizada (`tests/phase6_lifecycle.test.ts` - 9/9 pasados):**
  1. `GET /api/projects`: Retorna proyectos con tesis y contadores correctos (`pending: 2, accepted: 0, discarded: 0`).
  2. `GET /api/projects/:id`: Retorna detalle y cantidad de snapshots.
  3. `GET /api/projects/:id` (404): Manejo robusto de identificadores inexistentes.
  4. `GET /api/suggestions`: Paginación y filtrado por estado (`status=pending`).
  5. `GET /api/suggestions/:id`: Retorno de detalle enriquecido con veredicto, puntaje de confianza y razonamiento.
  6. `PATCH /api/suggestions/:id (ACCEPTED)`: Transiciona estado a `accepted`, actualiza `writtenToVault = true` y escribe físicamente el Callout `> [!tip]` en el archivo `suggestions.md` de la bóveda de pruebas.
  7. `PATCH /api/suggestions/:id (DISCARDED)`: Transiciona estado a `discarded` sin escribir ningún bloque en Obsidian.
  8. `GET /api/projects`: Refleja fielmente la actualización de conteos tras las decisiones del usuario (`pending: 0, accepted: 1, discarded: 1`).
  9. `PATCH /api/suggestions/:id` (Validación): Rechaza con HTTP 400 estados inválidos mediante Zod.

## C. Desviaciones y Decisiones de Diseño
- **De Auto-Sync Checkbox a Gated Callouts:** El concepto inicial planteaba escribir inmediatamente todas las sugerencias generadas como checkboxes (`- [ ]`) en Obsidian para luego sincronizar de vuelta los tildes del usuario. Esta premisa se refinó hacia el modelo Gated Callout (`> [!tip]`), donde la IA asiste pero nunca invade el espacio de notas del usuario sin una confirmación explícita (a través de la API o la UI de triaje).
- **Separación de Feedback y Estado:** Se agregaron las columnas `user_feedback` y `resolved_at` a la tabla `action_suggestions` para capturar la justificación del usuario, habilitando futuros bucles de aprendizaje y ajuste del evaluador.

**Estado:** Fase 6 COMPLETADA. Loom cuenta con un ciclo de vida de sugerencias robusto, API tipada de triaje, trazabilidad completa de feedback y sincronización idempotente hacia Obsidian.
