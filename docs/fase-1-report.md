# Reporte de Fase 1 (Core Data Layer & API)

## A. Qué se implementó
1. **Esquema Drizzle (1024D):** Se crearon las 6 tablas principales (`contents`, `projects`, `project_snapshots`, `evaluations`, `action_suggestions`, `llm_telemetry`) y se configuró Drizzle con `schemaFilter: ['public']` para ignorar a pg-boss. Se incorporó `vector(1024)` para alojar `bge-m3`.
2. **Scripts DB:** Creados los scripts en `src/db/` (`migrate.ts`, `reset.ts`, `seed.ts`) que levantan la extensión `pgvector` y aplican los cambios, enlazados en `package.json`.
3. **Repositorios Base:** Funciones transaccionales iniciales generadas en `src/db/repositories.ts` (inserción de contenidos, sugerencias, upsert de proyectos).
4. **Esqueleto API Fastify:** `src/api/server.ts` con manejo de errores, el endpoint `/health` y validación tipada usando `fastify-type-provider-zod`.
5. **Tests de Integración (Testcontainers):** Escritos los tests en `tests/db.test.ts` que levantan una base de datos temporal `pgvector:pg16`, aplican migraciones, comprueban restricciones `UNIQUE` y ejecutan una consulta de Búsqueda KNN.

## B. Evidencia y Pruebas
- **Migraciones**: El script de migración funciona creando la base de datos y la extensión `pgvector` exitosamente, aplicando los 6 esquemas.
- **Constraints**: La validación `UNIQUE` en `folder_path` (`projects`) evita duplicados en BDD.
- **Vector Search (KNN)**: Funciona correctamente devolviendo documentos cercanos según similitud del coseno.
- **EXPLAIN Plan**: La prueba de rendimiento insertó 10,000 registros sintéticos de vectores con 1024 dimensiones, y el `EXPLAIN` de PostgreSQL confirmó el uso de un **Index Scan usando `contents_embedding_idx` (índice HNSW)** en lugar de un escaneo secuencial.
- **Salida de tests:** `Test Files 1 passed (1). Tests 3 passed (3). Duration 42.70s` (tiempo mayoritariamente por inserción de los 10k vectores en BDD temporal).

## C. Desviaciones respecto al plan
- Debido a la imposibilidad de resolver la ruta de pg-pool global en algunas ejecuciones de migración, se delegaron las migraciones a un script personalizado en lugar del CLI simple, garantizando que `CREATE EXTENSION IF NOT EXISTS vector;` se ejecute preventivamente.

## D. Riesgos Nuevos Identificados
- **Operador de Distancia KNN:** Actualmente se utiliza el operador de distancia del coseno `<=>` en el test. Si `bge-m3` devuelve vectores no normalizados, habrá que aplicar L2 (`<->`). Aseguraremos que la inserción normalice (pooling `mean` + normalize).

**Estado:** Fase 1 COMPLETADA exitosamente. Todas las pruebas pasan (constraints, KNN y performance HNSW index). Esperando OK para iniciar la **Fase 2 (Ollama Provider + LangChain).**

---

## E. Addendum Post-Endurecimiento (Arquitectura Actual - Git `master`)
- **Gestión de Configuración y Resiliencia del Pool:** Se centralizó la configuración mediante Zod en `src/config.ts`. Se configuró el pool de conexiones de Postgres (`src/db/index.ts`) con el manejador de eventos `pool.on('error')` para evitar cierres del proceso ante interrupciones de conexión de red o conexiones inactivas descartadas.
- **Esquema de Base de Datos y Vectorial:** Las 6 tablas de Drizzle operan con la columna vectorial `vector(1024)` optimizada para `bge-m3`. Se mantiene el filtrado de esquemas para coexistencia limpia con `pgboss`.
- **Referencia Arquitectónica:** Ver [ARCHITECTURE.md](file:///c:/Projects/loom/docs/ARCHITECTURE.md) (Secciones 4 y 5) para detalles de esquemas y transacciones.

