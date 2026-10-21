import { z } from 'zod';
import type { ActionStep } from '../db/schema';
import type { AiProvider } from '../ai/aiProvider';
import type { LlmCallContext } from '../observability/llmTelemetry';
import { promptBlock } from '../ai/promptSafety';
import { answerInLine, Language, languageName } from '../ai/language';
import { getLogger } from '../observability/logger';
import { ProjectNoteRef, ResolvedTarget } from './targetFile';
import { headline, reasoningPart, resolveSteps } from './actionSteps';

const log = getLogger('structure-text');

/**
 * A second, short call after triage that lays out what the triage model already wrote: the action
 * as a headline and steps, and the reasoning as the connection first and what is missing. Asking
 * the triage call for that structure lowered verdict quality (macro-F1 0.75 to 0.69 on the labeled
 * set, docs/JOURNEY.md), so the triage prompt stays as measured and this call never sees a verdict
 * to change. Its input is model output derived from untrusted pages, so it is delimited, and its
 * output goes through the same checks as any action (actionSteps.ts). A failure keeps the plain text.
 */

export function structureSchema(output: Language) {
  const lang = languageName(output).lower;
  const step = z.object({
    note: z.string().nullish().describe("Ruta de la nota del ÍNDICE DE NOTAS donde se hace este paso, o la nota destino de la acción."),
    where: z.string().nullish().describe('Lugar dentro de la nota que la acción menciona: sección, encabezado, viñeta o acto. null si no lo menciona.'),
    change: z.string().describe(`Qué hacer, en una oración en ${lang}.`),
    text: z.string().nullish().describe('Texto para pegar que la acción ya incluye (una cita o una frase redactada), copiado tal cual. null si no incluye ninguno.'),
  });
  return z.object({
    connection: z.string().describe(`Conexión, en ${lang}: qué vincula el artículo con el proyecto según el razonamiento, en 1 o 2 oraciones, nombrando la nota o sección si el razonamiento la nombra. Empieza por la conexión misma: no empieces describiendo el artículo ni el proyecto.`),
    gap: z.string().nullish().describe(`Qué le falta para ser una contribución clara, o por qué no aplica, según el razonamiento, en 1 o 2 oraciones en ${lang}. null si el razonamiento no señala nada que falte.`),
    headline: z.string().nullish().describe(`Solo si hay <ACCION>: titular de la acción en una oración en ${lang} (máximo 20 palabras): qué agregar y en qué nota. null si no hay acción.`),
    steps: z.array(step).nullish().describe('Solo si hay <ACCION>: los pasos de la acción, de 1 a 4, en orden; cada paso es un cambio en una nota. null si no hay acción.'),
  });
}

export function structureSystemPrompt(output: Language): string {
  return `Reorganizas texto que ya escribió otro asistente sobre cómo un artículo se relaciona con un proyecto de escritura. No vuelvas a evaluar ni agregues ideas, datos o citas: usa solo lo que dicen el <RAZONAMIENTO> y la <ACCION>.
${answerInLine(output)}

REGLAS:
1. 'connection': lo que vincula el artículo con el proyecto, primero y sin resumir el artículo ni el proyecto.
2. 'gap': lo que el razonamiento dice que falta o por qué no aplica; null si no dice nada de eso.
3. Si hay <ACCION>: 'headline' en una oración y 'steps' con los pasos que la acción ya describe, cada uno en una nota del <INDICE_DE_NOTAS>. Copia en 'text', sin cambiarlas, las frases o citas para pegar que la acción incluye.
4. Si no hay <ACCION>: 'headline' y 'steps' en null.`;
}

export interface StructureInput {
  reasoning: string;
  action: { observation: string; suggestedAction: string; targetFile: string } | null;
  notes: readonly ProjectNoteRef[];
  output: Language;
}

export function structureUserMessage(input: StructureInput): string {
  const parts = [promptBlock('RAZONAMIENTO', input.reasoning)];
  if (input.action) {
    parts.push(promptBlock('ACCION', `Observación: ${input.action.observation}\nAcción: ${input.action.suggestedAction}\nNota destino: ${input.action.targetFile}`));
    parts.push(promptBlock('INDICE_DE_NOTAS', input.notes.map(n => `- ${n.path} — "${n.title}"`).join('\n') || '(sin notas)'));
  }
  return parts.join('\n\n');
}

export interface StructuredText {
  connection: string | null;
  gap: string | null;
  /** Set only when the action came back as steps; otherwise the triage text stays. */
  headline: string | null;
  steps: ActionStep[];
}

export async function structureSuggestionText(
  ai: AiProvider,
  input: StructureInput,
  target: ResolvedTarget | null,
  ctx: Omit<LlmCallContext, 'component'>,
): Promise<StructuredText | null> {
  try {
    const { data } = await ai.evaluateContent(structureSystemPrompt(input.output), structureUserMessage(input), structureSchema(input.output), undefined, { ...ctx, component: 'structure' });
    const connection = reasoningPart(typeof data?.connection === 'string' ? data.connection : null);
    if (!connection) return null;
    const steps = input.action && target ? resolveSteps(data.steps, input.notes, target) : [];
    const head = steps.length && typeof data.headline === 'string' && data.headline.trim() ? headline(data.headline) : null;
    return { connection, gap: reasoningPart(data.gap), headline: head, steps: head ? steps : [] };
  } catch (err) {
    log.warn({ err, traceId: ctx.traceId }, 'Could not structure the suggestion text; keeping the plain text');
    return null;
  }
}
