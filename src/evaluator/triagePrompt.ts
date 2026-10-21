import { z } from 'zod';
import { promptBlock } from '../ai/promptSafety';
import { answerInLine, Language, languageName } from '../ai/language';

// The triage prompt in each instruction language. With Spanish instructions and Spanish output
// it is byte-identical to the prompt measured in evals/REPORT.md; the English instructions exist
// so the harness can compare the two (PROMPT_LANGUAGE).

export interface TriageLanguages {
  prompt: Language;
  output: Language;
}

const ACTION_TYPES = ['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other'] as const;

export function triageSchema({ prompt, output }: TriageLanguages) {
  const d = prompt === 'es'
    ? {
      actionType: 'Tipo de acción constructiva para Obsidian',
      observation: 'Observación específica de lo que aporta constructivamente el artículo al proyecto',
      suggestedAction: 'Instrucción concreta de redacción o integración en las notas de Obsidian (ej. citar en Acto 2, crear puente narrativo).',
      targetFile: "Ruta de la nota del ÍNDICE DE NOTAS a la que apunta la acción, tal como aparece en el índice (ej. borrador.md o research/fuentes.md). Si ninguna nota existente encaja, el nombre de una nota NUEVA a crear (ej. contraargumentos.md) con 'targetIsNew' en true.",
      targetIsNew: "true solo si 'targetFile' es una nota nueva que no está en el índice; false si es una nota existente.",
      verdict: "Veredicto: 'actionable' si aporta ideas, citas o argumentos concretos para enriquecer el borrador; 'tentative' si es tangencial o dudoso; 'irrelevant' si no aporta nada o está fuera de foco.",
      confidenceScore: 'Puntaje decimal entre 0.0 y 1.0 que mide el grado de afinidad temática y relevancia con el proyecto: 0.0-0.3 si es irrelevant, 0.4-0.6 si es tentative, 0.7-1.0 si es actionable.',
      triageReasoning: `Razonamiento detallado en ${languageName(output).lower} explicando por qué es útil o por qué es irrelevante`,
      action: "Propuesta de acción concreta. REQUERIDO si verdict es 'actionable'. Debe ser null si verdict es 'tentative' o 'irrelevant'.",
    }
    : {
      actionType: 'Type of constructive action for Obsidian',
      observation: 'Specific observation of what the article constructively brings to the project',
      suggestedAction: 'Concrete writing or integration instruction for the Obsidian notes (e.g. cite in Act 2, build a narrative bridge).',
      targetFile: "Path of the note from the NOTE INDEX the action points to, exactly as listed (e.g. draft.md or research/sources.md). If no existing note fits, the name of a NEW note to create (e.g. counterarguments.md) with 'targetIsNew' set to true.",
      targetIsNew: "true only if 'targetFile' is a new note that is not in the index; false for an existing note.",
      verdict: "Verdict: 'actionable' if it brings concrete ideas, quotes or arguments that enrich the draft; 'tentative' if it is tangential or doubtful; 'irrelevant' if it adds nothing or is off topic.",
      confidenceScore: 'Decimal score between 0.0 and 1.0 measuring thematic affinity and relevance to the project: 0.0-0.3 if irrelevant, 0.4-0.6 if tentative, 0.7-1.0 if actionable.',
      triageReasoning: `Detailed reasoning in ${languageName(output, 'en').lower} explaining why it is useful or why it is irrelevant`,
      action: "Concrete action proposal. REQUIRED if verdict is 'actionable'. Must be null if verdict is 'tentative' or 'irrelevant'.",
    };

  const actionSchema = z.object({
    actionType: z.enum(ACTION_TYPES).describe(d.actionType),
    observation: z.string().describe(d.observation),
    suggestedAction: z.string().describe(d.suggestedAction),
    targetFile: z.string().nullish().describe(d.targetFile),
    targetIsNew: z.boolean().nullish().describe(d.targetIsNew),
  });
  return z.object({
    verdict: z.enum(['actionable', 'tentative', 'irrelevant']).describe(d.verdict),
    confidenceScore: z.number().min(0).max(1).describe(d.confidenceScore),
    triageReasoning: z.string().describe(d.triageReasoning),
    action: actionSchema.nullable().describe(d.action),
  });
}

export type TriageResult = z.infer<ReturnType<typeof triageSchema>>;

export function triageSystemPrompt({ prompt, output }: TriageLanguages): string {
  if (prompt === 'en') {
    return `You are a critical and constructive research and writing assistant. Your job is to analyze whether the ARTICLE brings real value, new ideas or useful evidence to the PROJECT'S DRAFTS AND NOTES.
${answerInLine(output, 'en')}

EVALUATION RULES:
1. 'actionable': USE IT ONLY if you find a concrete, useful way to integrate the article into the notes (cite evidence, counter-argument, narrative bridge between acts). If it is 'actionable', the 'action' object MUST be complete with a constructive action. NEVER suggest 'discard'!
2. 'tentative': The content is thematically related but offers no clear or priority contribution. The 'action' field must be null.
3. 'irrelevant': The article is about something else, adds nothing or should be ignored. The 'action' field must be null.
4. Target note: in 'action.targetFile' give the note from the NOTE INDEX where the action belongs, which may differ from the note closest to the article. If no existing note fits, propose a new note and set 'targetIsNew' to true.

[VERY IMPORTANT]: The 'confidenceScore' field MUST be a decimal number between 0.0 and 1.0 that quantifies the affinity with the project: 0.0 to 0.3 if 'irrelevant', 0.4 to 0.6 if 'tentative', and 0.7 to 1.0 if 'actionable'.`;
  }
  return `Eres un asistente de investigación y redacción crítico y constructivo. Tu misión es analizar si el ARTÍCULO aporta valor real, ideas nuevas o evidencia útil a los BORRADORES Y NOTAS DEL PROYECTO.
${answerInLine(output)}

REGLAS DE EVALUACIÓN:
1. 'actionable': ÚSALO SOLAMENTE si encuentras una forma concreta y útil de integrar el artículo en las notas (citar evidencia, contraargumento, puente narrativo entre actos). Si es 'actionable', el objeto 'action' DEBE estar completo con una acción constructiva. ¡NUNCA sugieras 'descartar'!
2. 'tentative': El contenido tiene relación temática pero no ofrece una contribución clara ni prioritaria. El campo 'action' debe ser null.
3. 'irrelevant': El artículo trata otro tema, no aporta nada o debe ser ignorado. El campo 'action' debe ser null.
4. Nota destino: en 'action.targetFile' indica la nota del ÍNDICE DE NOTAS donde corresponde la acción, que puede ser distinta de la nota más cercana al artículo. Si ninguna nota existente encaja, propón una nota nueva y marca 'targetIsNew' en true.

[MUY IMPORTANTE]: El campo 'confidenceScore' DEBE ser un número decimal entre 0.0 y 1.0 que cuantifique la afinidad con el proyecto: 0.0 a 0.3 si es 'irrelevant', 0.4 a 0.6 si es 'tentative', y 0.7 a 1.0 si es 'actionable'.`;
}

export interface TriageContext {
  /** The note closest to the article, a hint for the model; it may choose another. */
  matchedNotePath?: string | null;
  matchedNoteTitle?: string | null;
  /** The notes context (notesContext.ts): every note's path and the notes' text within the budget. */
  projectNotes: string;
  thesisText?: string | null;
  /** Article summary, already capped. */
  summary: string;
}

export function triageUserMessage(prompt: Language, c: TriageContext): string {
  const en = prompt === 'en';
  const notes = c.projectNotes || c.thesisText || (en ? 'Project with no additional notes.' : 'Proyecto sin notas adicionales.');
  const heading = en ? "PROJECT'S NOTES AND DRAFTS:" : 'NOTAS Y BORRADORES DEL PROYECTO:';
  // The notes come first and do not depend on the article, so the prompt prefix repeats across
  // articles and providers can serve it from their cache
  let closestNote = '';
  if (c.matchedNotePath) {
    const title = c.matchedNoteTitle ? ` ("${c.matchedNoteTitle}")` : '';
    closestNote = en
      ? `\n\nNOTE CLOSEST TO THE ARTICLE (a hint, not a requirement): ${c.matchedNotePath}${title}`
      : `\n\nNOTA MÁS CERCANA AL ARTÍCULO (orientativa, no obligatoria): ${c.matchedNotePath}${title}`;
  }
  const closing = en
    ? 'Please critically evaluate the affinity and the constructive proposal following the structured rules.'
    : 'Por favor, evalúa de manera crítica la afinidad y propuesta constructiva siguiendo las reglas estructuradas.';

  return `${promptBlock('PROJECT_CONTEXT', `${heading}
${notes}${closestNote}`)}

${promptBlock('ARTICLE_SUMMARY', c.summary)}

${closing}`;
}

/** An "actionable" answer whose action is really to drop the article, in either language. */
export function isDiscardAction(action: { actionType: string; observation: string; suggestedAction: string }): boolean {
  const actionText = (action.suggestedAction || '').toLowerCase().trim();
  const observation = (action.observation || '').toLowerCase().trim();
  return actionText.startsWith('descartar')
    || actionText.includes('descartar el artículo')
    || actionText.includes('no incluir')
    || actionText.startsWith('discard')
    || actionText.includes('discard the article')
    || actionText.includes('do not include')
    || (action.actionType === 'other' && (observation.includes('no aporta') || observation.includes('adds nothing') || observation.includes('does not add')));
}
