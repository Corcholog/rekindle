# Reporte de Fase 0 (Fundaciones y Spikes)

## A. Qué se implementó
1. **Scaffolding del Monorepo:** Inicialización con `pnpm` workspace, Node.js 24 LTS, TypeScript strict, ESLint, y Vitest configurado con un test dummy (`dummy.test.ts`) pasando con éxito.
2. **Infraestructura Core:** Configurado `docker-compose.yml` para levantar `pgvector/pgvector:pg16` para la base de datos de Loom.
3. **Drafts de ADRs (Architecture Decision Records):**
   - `001-decisiones-arquitectura-a1-a10.md`: Recoge la normalización de URLs, el hashing canónico sin `suggestions.md`, el gating de re-evaluación, la telemetría, y la estrategia de writeback con callouts idempotentes.
   - `002-modelo-embedding.md`: Registra el uso inicial de `@huggingface/transformers` y los resultados del spike.
4. **Golden Dataset Template:** Plantilla JSON `golden-dataset-template.json` generada en `tests/fixtures/` lista para ser etiquetada por el usuario.
5. **Spikes Ejecutables:** Se crearon 4 scripts de spike en `/spikes/`.

## B. Evidencia y Pruebas
- La suite de `vitest` pasó en verde (tiempo: ~900ms).
- El contenedor PostgreSQL (con pgvector) fue orquestado correctamente vía docker-compose.
- **Resultado de Spike 2 (ONNX Embeddings):** 
  - *Memoria Base (Node.js):* 329.84 MB
  - *Memoria Modelo Cargado (`Xenova/paraphrase-multilingual-MiniLM-L12-v2` q8):* 664.82 MB
  - **Veredicto:** **NO-GO**. Excede el límite de 500 MB (RNF-01). Requeriremos cambiar a `Xenova/multilingual-e5-small` o descargar un modelo más compacto, o bien invocar Ollama para embeddings si queremos delegar la carga al modelo local externo.

## C. Desviaciones respecto al plan
- Debido a restricciones de ejecución de scripts de `pnpm.ps1` en PowerShell del sistema host, las instalaciones se lanzaron envolviéndolas en `cmd /c`.
- Los scripts de pre-build (`onnxruntime-node`) requieren la flag `ignore-scripts false` y/o aprobación explícita en pnpm.

## D. Riesgos Nuevos Identificados
- **Memoria RAM Crítica (RNF-01):** El spike de embeddings demuestra que cargar el modelo ONNX más Node empuja el RSS a ~665 MB de entrada. Si cargamos además colas e inyecciones a la BD, rondaremos los 800 MB. Tendremos que usar embeddings vía Ollama, una API externa, o abstraer el worker de embeddings en un script separado (ej. Python/C++) que se lance por spawn solo cuando se requiera.

**Estado:** Fase 0 completada. Esperando dictamen sobre el NO-GO de la memoria RAM de embeddings y la orden (OK) para avanzar a la Fase 1.

---

## E. Addendum Post-Endurecimiento (Arquitectura Actual - Git `master`)
- **Resolución de Spike 2 (Embeddings):** Como se anticipó en el veredicto NO-GO de Fase 0 respecto al consumo excesivo de memoria de `@huggingface/transformers` en el proceso Node (>660 MB), la arquitectura adoptó `bge-m3` ejecutado de forma desacoplada en el servidor de Ollama (`@langchain/ollama`). Esto mantuvo el proceso Node en márgenes estrictos de consumo (RNF-01).
- **Evolución de ADRs:** Los borradores iniciales fueron formalizados y actualizados con adendas en [001-decisiones-arquitectura-a1-a10.md](file:///c:/Projects/loom/docs/adr/001-decisiones-arquitectura-a1-a10.md) y [002-modelo-embedding.md](file:///c:/Projects/loom/docs/adr/002-modelo-embedding.md), y se formalizó el endurecimiento de seguridad e idempotencia en [003-endurecimiento-post-revision.md](file:///c:/Projects/loom/docs/adr/003-endurecimiento-post-revision.md).
- **Especificación Completa:** Para la referencia técnica exhaustiva del sistema, consultar [ARCHITECTURE.md](file:///c:/Projects/loom/docs/ARCHITECTURE.md).

