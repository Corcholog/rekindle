# Reporte de Fase 2 (Ollama Provider & LangChain Core)

## A. Qué se implementó
1. **OllamaProvider (`src/ai/OllamaProvider.ts`):** Clase que abstrae la comunicación con la API de Ollama usando `@langchain/ollama`.
2. **Generación de Embeddings:** Implementación del método `getEmbedding` utilizando `OllamaEmbeddings` apuntando al modelo `bge-m3` para devolver vectores de 1024 dimensiones.
3. **Estructuración JSON con Qwen:** Implementación de `evaluateContent` usando `ChatOllama` (`qwen2.5:7b-instruct`) y `.withStructuredOutput()`. Esto garantiza que la salida cumpla estrictamente con un esquema de Zod (sin strings sueltos ni verbosidad extra).
4. **Resiliencia:** Se configuraron `maxRetries: 3` en la inicialización de los modelos para manejar interrupciones en la conexión, además de una temperatura baja (`temperature: 0.1`) para priorizar respuestas determinísticas.

## B. Evidencia y Pruebas
- **Test de Integración (`tests/ollama.test.ts`):** 
  - *Vectorización:* Se solicitó un embedding y se verificó que la respuesta fuera un array numérico de longitud 1024.
  - *Extracción Estructurada JSON:* Se le pasó a `qwen2.5` un esquema de evaluación (`verdict`, `confidenceScore`, `reasoning`) junto con un texto de prueba. El modelo devolvió el objeto JSON parseado correctamente sin arrojar errores de Zod.
- **Salida de tests:** `Test Files 1 passed (1). Tests 2 passed (2). Duration 65.08s` (El tiempo total contempla el "cold start" de Ollama cargando los pesos de ambos modelos a la RAM/VRAM en el primer llamado).

## C. Desviaciones respecto al plan
- Se utilizó `.withStructuredOutput(schema)` nativo de LangChain en lugar de forzar manualmente `format: 'json'` y parsear el string devuelto, ya que las nuevas versiones de LangChain manejan el tipado de Ollama de forma más robusta delegando la validación del schema.

## D. Riesgos Nuevos Identificados
- **Gestión de Memoria en la Máquina Host:** Al cargar alternadamente o en paralelo `bge-m3` y `qwen2.5`, Ollama consume ~6 GB de memoria. Si bien los límites de hardware se relajaron (como definimos en el ADR 002), el tiempo de respuesta (latencia) inicial puede rondar los 30-40 segundos por documento si el modelo sufre de swapping frecuentemente. Se recomienda evaluar en el futuro pasar un parámetro `keep_alive` extendido a la API si se harán procesamientos en lote masivos (Fase 3).

**Estado:** Fase 2 COMPLETADA exitosamente. Infraestructura base de IA local validada.

---

## E. Addendum Post-Endurecimiento (Arquitectura Actual - Git `master`)
- **Arquitectura Híbrida Cloud / Local con Fallback:** Se integró `@google/genai` en `src/ai/OllamaProvider.ts` para permitir el uso opcional de Gemini (`gemini-2.5-pro` por defecto) cuando se proporciona `GEMINI_API_KEY`. En caso de desconexión, error de red o cuota excedida de la API cloud, el sistema hace fallback automático e imperceptible hacia `ChatOllama` (`qwen2.5:7b-instruct`).
- **Embeddings Incondicionalmente Locales:** Independientemente del modelo de chat utilizado, la generación de embeddings se realiza de manera 100% local a través de `OllamaEmbeddings` con `bge-m3` (1024D).
- **Límites de Contexto Seguros:** Se acotaron las entradas de texto en los prompts de inferencia (máximo 15,000 caracteres de notas de proyectos y 50,000 de artículos web) para evitar desbordar ventanas de contexto o saturar la memoria RAM.
- **Referencia Arquitectónica:** Ver [ARCHITECTURE.md](file:///c:/Projects/loom/docs/ARCHITECTURE.md) (Sección 6) para el contrato de la capa de IA.

