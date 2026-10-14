# Reporte de Fase 7 (Web UI, Triaje & Gestión del Vault)

## A. Qué se implementó
1. **Frontend Web Ligero (`web/`):**
   - Implementado en Vanilla JavaScript (ES Modules nativos), HTML5 semántico y CSS3 moderno (tokens HSL, glassmorphism con `backdrop-filter`, dark mode curado y micro-animaciones). Cero dependencias de empaquetado o frameworks pesados, respetando el presupuesto de memoria de Loom.
   - Servido directamente desde Fastify mediante `@fastify/static` en el puerto `3000`.
   - **Bandeja de Entrada (Inbox):** Formulario para procesar URLs, feed en vivo con chips de estado (`Pendiente`, `Extrayendo`, `Resumiendo`, `Vectorizando`, `Listo`, `Falló`), reintento ante fallos y modal de inspección con resumen generado y veredictos por proyecto.
   - **Pestaña de Sugerencias:** Selector de proyectos en barra lateral con contadores de pendientes, filtros por estado (`Pendientes`, `Aceptadas`, `Descartadas`), widgets colapsables para inspeccionar el razonamiento de la IA con barra de confianza, campo para notas opcionales y botones de acción ("Aceptar" / "Descartar").
   - **Pestaña de Configuración del Vault:** Formulario para consultar y cambiar la ruta raíz del Vault de Obsidian con validación en vivo de disco, banner de advertencia global ante desconexión, indicador de estado de conexión y tabla diagnóstica de proyectos detectados.

2. **Endpoints de API (Fastify + Zod):**
   - `GET /api/contents` (paginación, filtros de estado y contadores de evaluación).
   - `GET /api/contents/:id` (detalle con resumen estructurado y evaluaciones multi-proyecto).
   - `PATCH /api/suggestions/:id` (transición de estados, feedback de usuario, escritura atómica en Obsidian y rechazo 409 ante modificaciones de ítems ya resueltos).
   - `GET /api/settings/vault` (estado actual, validez de ruta y proyectos detectados).
   - `POST /api/settings/vault` (validación de ruta, actualización de `.env`, reinicio en caliente del observador de archivos y reconciliación de proyectos).
   - `POST /api/settings/vault/rescan` (re-escaneo forzado de notas sobre el vault activo).

3. **Política de Escritura Gated (Accept-Only Writeback):**
   - Se resolvió el conflicto de doble escritura: las sugerencias pendientes **nunca** tocan Obsidian antes de ser revisadas. Únicamente las sugerencias aceptadas explícitamente por el usuario se escriben en el archivo `suggestions.md` del proyecto en formato Callout (`> [!tip] Sugerencia Aceptada:`).
   - Idempotencia total garantizada: aceptar repetidamente una sugerencia no duplica bloques en Obsidian.

4. **Ciclo de Vida de Proyectos y Evaluación Retrospectiva (Opción A):**
   - Las rutas de proyectos se gestionan relativas a la raíz del Vault (`Projects/NombreProyecto`). Si el usuario traslada su Vault a otro disco o carpeta, las notas, sugerencias e historial se conservan al 100%.
   - Si un proyecto no existe en el Vault actual, se marca como inactivo (`isActive = false`, `existsOnDisk = false`) sin eliminar su historial ni sugerencias previas.
   - **Opción A implementada:** Al reactivar un proyecto (o crear uno nuevo), pgvector busca artículos consumidos previamente que no hayan sido evaluados contra su tesis (`distancia < 0.6`) y los encola de forma dosificada (*throttled*) en `pg-boss` para que el LLM genere sugerencias retrospectivas sin sobrecargar el sistema.

## B. Evidencia y Pruebas
- **`tests/phase7_ui.test.ts` (9/9 pasados):** Validación del servidor estático, ingesta vía API, listado de contenidos, triaje por estados, idempotencia de aceptación e inmunidad a reescrituras redundantes.
- **`tests/settings_vault.test.ts` (6/6 pasados):** Validación de lectura de configuración, rechazo HTTP 400 ante rutas no existentes, desactivación elegante de proyectos ausentes, reactivación automática al volver al Vault original y detección de backlog previo (Opción A).
- **`tests/phase6_lifecycle.test.ts` (9/9 pasados):** Verificación del ciclo de vida de sugerencias y escritura en disco.
- **`tests/parser.test.ts` (5/5 pasados):** Extracción de frontmatter y etiquetas en Markdown.
- **`tests/full_e2e.test.ts` (1/1 pasado):** Flujo completo end-to-end con embeddings locales BGE-M3 y base de datos pgvector.

## C. Desviaciones y Decisiones de Diseño
1. **Preservación del Widget de Razonamiento:** Se diagnosticó que el refresco automático cada 3 segundos destruía el estado de los elementos `<details>`. Se implementó un control de firmas en el DOM y persistencia en memoria (`state.openDetails` y `state.loadedReasonings`) para permitir una lectura ininterrumpida mientras se procesan artículos en segundo plano.
2. **Eliminación de Atajos de Teclado:** Por solicitud explícita del usuario, se eliminó completamente la lógica de selección de tarjeta por teclado y atajos (`A`/`D`) en favor de una interacción directa y limpia mediante botones.
3. **Resiliencia en Pool de PostgreSQL:** Se incorporó el manejador de eventos `pool.on('error')` en `src/db/index.ts` para evitar que caídas de conexiones inactivas (TCP FIN) provoquen un cierre no controlado del proceso Node.js.

**Estado:** Fase 7 COMPLETADA. Loom cuenta con una interfaz web totalmente operativa, tablero de triaje contextualmente enlazado con Obsidian, pantalla de ajustes para reubicar la bóveda y evaluación retrospectiva automática.
