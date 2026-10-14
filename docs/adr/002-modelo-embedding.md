# ADR 002: Modelo de Embedding Local (ONNX)

## Contexto
Requerimos un modelo multilingüe (ES/EN) para incrustar resúmenes y tesis localmente en la máquina del usuario, usando menos de 500 MB de RAM y CPU (ONNX a través de `@huggingface/transformers`).

## Opciones Consideradas
1. `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensiones, muy probado).
## Decisión
Dado que el usuario redacta en **español** pero consume contenido en **español e inglés** (requiriendo recuperación semántica *cross-lingual* o multilingüe cruzada) y que **se han relajado los límites estrictos de memoria RAM (< 500MB)**, proponemos la siguiente arquitectura de modelos apoyada enteramente en **Ollama**:

1. **Embeddings (Capa 1):** Usar el modelo `bge-m3` (1.2 GB). Este modelo es estado del arte en tareas multilingües cruzadas, permitiendo que un video en inglés asocie su semántica a un proyecto en español perfectamente.
   - *Impacto:* Se actualizará el esquema de Drizzle para usar `vector(1024)` en lugar de 384.
2. **Triaje y Resumen (Capa 2):** Usar `qwen2.5:7b-instruct` (4.7 GB). La familia Qwen 2.5 tiene un desempeño excepcionalmente superior en idioma español y estructuración JSON en comparación con modelos pequeños como `llama3.2:3b`.

## Consecuencias
- El sistema delegará las cargas más pesadas a Ollama, usando de 6 a 8 GB de RAM/VRAM en total.
- Se elimina la dependencia de `@huggingface/transformers` en Node.js, manteniendo el servidor de API extremadamente ligero, a cambio de que Ollama asuma la carga de memoria.
- Alta fidelidad semántica bilingüe.
