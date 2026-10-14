# Reporte de Fase 4 (Sincronización Bidireccional con Obsidian Vault)

## A. Qué se implementó
1. **Watcher en Tiempo Real:** En `src/vault/watcher.ts`, la librería `chokidar` monitorea constantemente los directorios `Projects` y `Proyectos` de la carpeta Vault, debouncing las actualizaciones para evitar disparar demasiados eventos en escrituras continuas.
2. **Reconciliador y Hashes:** Se calcula un hash MD5 de los contenidos (`src/vault/hash.ts`). Si el proyecto no cambia, se ignora. Si cambia, el `reconciler.ts` actualiza la base de datos `projects` guardando el hash nuevo, actuando como un sistema de control de versiones.
3. **Parseo Semántico y Tesis:** Se escanea cada archivo Markdown del proyecto usando `gray-matter` (`src/vault/parser.ts`). Extrae el título, y busca archivos etiquetados con `#project`. Extrae la "tesis" o idea principal.
4. **Captura y Snapshot:** Se envía la tesis a Ollama para crear su Embedding, insertando finalmente una fila en la tabla `project_snapshots` para mantener registro del historial y posición matemática de la idea del usuario.

## B. Idioma de la Extracción
- **Consideración Crítica Aplicada:** Como el usuario consume contenido mixto pero escribe sus ideas en **español**, el parser toma el texto exacto tal cual lo redactó el usuario en Obsidian. Los embeddings generados de las tesis estarán en español como base, lo que alinea semánticamente el proyecto con los resúmenes web de la Fase 3.

## C. Evidencia y Pruebas
- El pipeline inicial se ejecuta usando un *Boot Reconcile* al arrancar el servidor `Fastify` (`bootReconcile` -> sincroniza todo de golpe).
- **Cobertura Automatizada (Completada en Fases 6 y 7):**
  - `tests/parser.test.ts`: Valida unitariamente la extracción de frontmatter YAML, detección de `#project` y extracción de tesis.
  - `tests/phase6_lifecycle.test.ts` y `tests/settings_vault.test.ts`: Pruebas de integración sobre bóvedas simuladas verificando detección de carpetas de proyectos, recálculo de hashes, alternancia de rutas en caliente y persistencia de snapshots.
  - `tests/full_e2e.test.ts`: Prueba de integración end-to-end con BGE-M3 y base de datos pgvector.

**Estado:** Fase 4 COMPLETADA. Sincronización continua de Vault operando y validada por suites de integración automatizadas.
