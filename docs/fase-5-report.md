# Reporte de Fase 5 (Evaluator & Action Suggestions)

## A. Qué se implementó
1. **Motor Evaluador (`src/evaluator/index.ts`):** 
   - Se diseñó la lógica para buscar los proyectos más relevantes a un artículo usando una consulta de similitud de vectores (K-Nearest Neighbors: `<=>`) en Drizzle, limitando a los 3 mejores resultados para evitar procesar toda la base de datos.
   - Para cada proyecto coincidente, se realiza un **Triage aislado** mediante `qwen2.5:7b-instruct`.
   - Se crearon esquemas estrictos (Zod) para forzar al LLM a devolver un JSON con un veredicto (`actionable`, `tentative`, `irrelevant`) y puntajes de confianza decimales.
   - Si el Triage es exitoso (`actionable`), se dispara una segunda inferencia independiente para generar sugerencias accionables concretas para el proyecto en base al artículo.
2. **Evaluación en Segundo Plano:** 
   - Se añadió un worker dedicado (`src/workers/evaluationWorker.ts`) y una cola en `pg-boss` (`evaluate_content`).
   - Se vinculó el término de la ingesta (Fase 3) para que encole la evaluación automáticamente.
3. **Restricción de Idioma:** Los *system prompts* de Triage y Generación de Acciones exigen explícitamente razonamiento y respuestas en **ESPAÑOL**.

## B. Evidencia y Pruebas
- Se codificó `tests/evaluation.test.ts`. El test simula un proyecto sobre "Agentes Autónomos" y un artículo sobre "Pub/Sub".
- Tras cruzar los vectores simulados, el Evaluator pasa el texto a Qwen2.5 de manera local.
- Se corrigieron ambigüedades en la descripción del esquema Zod (ej. especificando `formato decimal estricto del 0.0 al 1.0 (Ejemplo: 0.8)`) debido a alucinaciones menores del modelo al formatear números, probando la utilidad de LangChain para la recuperación de errores (`OutputParserException`).

## C. Desviaciones respecto al plan y Refinamientos Posteriores
- Se implementó la iteración individual por proyecto (1 llamado LLM por cada coincidencia) en lugar de un *prompt* masivo. Esto previene la "alucinación de contexto" y garantiza escalabilidad. El sistema es fácilmente mutable a un proveedor vía API (OpenAI/Gemini) si el hardware local resultara insuficiente en el futuro.
- **Refinamientos del Motor Evaluador (incorporados en Fase 7):**
  - *Filtro de Proyectos Activos:* La búsqueda vectorial restringe la coincidencia a proyectos con `p.is_active = true`, evitando gastar tiempo de inferencia en proyectos ausentes del Vault actual.
  - *Umbral de Distancia Coseno:* Se formalizó el filtro `ps.embedding <=> content.embedding < 0.6` para asegurar relevancia semántica estricta.
  - *Idempotencia Pre-Inferencia:* Se añadió una comprobación previa en PostgreSQL para detectar si la evaluación ya existe antes de invocar a Ollama, eliminando re-ejecuciones costosas.
  - *Evaluación Dirigida y Backlog (Opción A):* Se agregó el parámetro opcional `targetProjectId` y las funciones `findBacklogUnevaluatedContents` y `enqueueProjectBacklogEvaluations` para evaluar retrospectivamente contenidos históricos cuando un proyecto se reactiva.

**Estado:** Fase 5 COMPLETADA y refinada. El "Cerebro" de Loom está funcionando de forma robusta, conectando lecturas web con los Proyectos de Obsidian y generando valor accionable.

---

## D. Addendum Post-Endurecimiento (Arquitectura Actual - Git `master`)
- **Acotación de Ventana de Contexto:** Se implementó truncamiento preventivo a 15,000 caracteres en las notas de proyectos y 50,000 en artículos web enviados al evaluador, impidiendo saturación de contexto y latencias excesivas en inferencias locales.
- **Sugerencias Virtuales (`tentative` / `irrelevant`):** Para mantener la integridad relacional de la tabla `evaluations`, los veredictos no accionables se presentan en la API como sugerencias virtuales. Esto permite al usuario explorar ideas tentativas o descartadas desde la interfaz sin sobreescribir el veredicto del modelo ni crear filas redundantes en `action_suggestions` hasta que exista una decisión explícita.
- **Filtro de Descarte Temprano:** Se agregó un filtro semántico que descarta sugerencias con frases vacías antes de persistirlas, reduciendo ruido en la bandeja de triaje.
- **Referencia Arquitectónica:** Ver [ARCHITECTURE.md](file:///c:/Projects/loom/docs/ARCHITECTURE.md) (Sección 9) para detalles completos del motor de evaluación.

