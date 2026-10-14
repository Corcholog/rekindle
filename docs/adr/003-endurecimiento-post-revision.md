# ADR 003: Endurecimiento posterior a la revisión de código

## Contexto
Una revisión de código (ver `docs/code-review.md`) detectó problemas de seguridad, fiabilidad y mantenibilidad en una versión funcional del sistema. Los cambios se aplicaron en tres commits: `f1e6620` (P1), `094c5d3` (P2) y `855e4f6` (P3).

## Decisiones

### D1: Servidor solo local por defecto
`HOST` por defecto es `127.0.0.1` (antes `0.0.0.0`). La API no tiene autenticación y puede ingerir URLs arbitrarias y modificar la ruta del vault, por lo que no debe exponerse a la red sin una capa de autenticación.

### D2: Frontera de entrada de URLs
Solo `http` y `https`. La descarga usa timeout de 15 s, tope de 5 MB (cabecera y cuerpo real) y valida el tipo de contenido (HTML, XHTML o texto). La interfaz solo enlaza URLs `http(s)` (`safeUrl`). **No** se bloquean hosts privados/loopback.

### D3: El fallo de embedding no se persiste
Si no se puede calcular el embedding de un proyecto, no se guarda el hash ni el snapshot; el siguiente evento, arranque o re-escaneo lo reintenta. La actualización del proyecto y la creación del snapshot ocurren en una transacción.

### D4: El hash refleja solo lo que se lee
`getDirectoryHash` considera únicamente los `*.md` del primer nivel de la carpeta del proyecto (excluido `suggestions.md`), incluye el nombre de archivo y calcula el SHA-256 en streaming. Consecuencia: la primera ejecución tras actualizar produce un único re-sincronizado de todos los proyectos.

### D5: Proveedor de IA
- Una instancia compartida (`sharedAiProvider`) y configuración central (`src/config.ts`, validada con Zod).
- Gemini: `systemInstruction` + `responseJsonSchema`. Ollama: `numCtx = 16384`.
- Texto no confiable (resumen del artículo) y contexto del proyecto viajan en el mensaje de usuario dentro de etiquetas (`<PROJECT_CONTEXT>`, `<ARTICLE_SUMMARY>`), no en el prompt de sistema. Límites: notas 15 000 y resumen 10 000 caracteres.
- Se registra el modelo realmente usado (`llm_telemetry.model_name`).

### D6: Idempotencia y concurrencia
- Ingesta: `INSERT … ON CONFLICT (uri) DO UPDATE` (incrementa `consumption_seq`); jobs con `singletonKey` y `retryLimit: 2`. Los errores permanentes (404, tipo no soportado, sin subtítulos, etc.) no se relanzan a pg-boss.
- Escritura al vault: reclamo atómico de `written_to_vault` antes de escribir, con reversión si falla el disco.
- Aceptar un ítem *tentativo* es idempotente por `evaluation_id`.
- Reconciliación: bloqueo en memoria por proyecto (las ejecuciones concurrentes se **omiten**).

### D7: Apagado ordenado
`SIGINT`/`SIGTERM` detienen el watcher, `pg-boss`, el servidor y el pool de PostgreSQL.

## Consecuencias
- Problemas conocidos que **quedan abiertos** (detalle en `docs/ARCHITECTURE.md`, sección 14):
  - Aceptar un ítem tentativo ya no modifica la evaluación, por lo que puede seguir apareciendo como *tentativo*; descartar sigue sobrescribiendo el veredicto del LLM.
  - Una reconciliación omitida por el bloqueo no se reencola.
  - Con `GEMINI_API_KEY` se envían fragmentos de las notas del usuario a la nube (contradice ADR 001, A9).
  - No hay autenticación ni bloqueo de IPs privadas.
- `.eslintrc.json`, `pnpm typecheck` y un `tsconfig` con resolución `bundler` forman parte del flujo de calidad.
