# Reporte de Fase 3 (Ingestion Worker y Colas)

## A. Qué se implementó
1. **Gestor de Colas (pg-boss):** Se inicializó la instancia `pg-boss` conectada a nuestra base de datos PostgreSQL, encargada de manejar la asincronía y reintentos (ver `src/queue/index.ts`).
2. **Endpoint de Ingesta:** Se creó el endpoint `POST /api/ingest` que acepta un URL, verifica si ya existe (o lo crea) y encola un trabajo `ingest_url` en la cola, devolviendo un código 202 (Accepted) casi instantáneamente.
3. **Ingestion Worker:** En `src/workers/ingestionWorker.ts`, el job procesa las URLs de principio a fin secuencialmente:
   - *Scraping:* Extrae el contenido limpio usando `jsdom` y `@mozilla/readability` (limitado a 50,000 caracteres por seguridad).
   - *Resumen (Ollama):* Se fuerza a `qwen2.5:7b-instruct` a generar un resumen, y **se obliga estrictamente al modelo a responder en español** (cumpliendo la regla del idioma base), independientemente del idioma de la URL.
   - *Embedding (Ollama):* Se pasa el resumen (en español) a `bge-m3` para generar el vector 1024D y finalmente el estado pasa a `ready`.

## B. Evidencia y Pruebas
- **Test de Integración End-to-End:** Se construyó `tests/ingestion.test.ts` que arranca la DB con testcontainers, la cola, la API y mockea el `fetch`. Todo el pipeline se ejecuta y verifica el flujo del estado `pending -> extracting -> summarizing -> embedding -> ready`.
- **Límites de Concurrencia:** La estructura de worker en `pg-boss` ejecuta secuencialmente los items para evitar saturar la RAM de Ollama y causar cuellos de botella (OOM).

## C. Desviaciones respecto al plan
- En lugar de fragmentar los pasos (ej. jobs distintos de `extract`, `summary`, `embedding`), el usuario optó por un único pipeline secuencial dentro del mismo worker job `ingest_url`, simplificando la gestión de estado de la BDD, lo cual es válido para un MVP.

**Estado:** Fase 3 COMPLETADA exitosamente. Infraestructura de procesamiento asíncrono validada.
