import { z } from 'zod';
import type { AiProvider } from './aiProvider';

export const summarySchema = z.object({
  summary: z.string().describe('Un resumen estructurado del contenido extraído'),
});

export const SUMMARY_SYSTEM_PROMPT = "Eres un analista experto. Resume el texto proporcionado de manera concisa enfocándote en los puntos clave. Importante: Escribe el resumen siempre en Español, incluso si el texto original está en Inglés u otro idioma.";

/** Spanish summary of an article or transcript; shared by ingestion and the eval harness. */
export async function summarizeText(ai: AiProvider, rawText: string): Promise<string> {
  const { data } = await ai.evaluateContent(SUMMARY_SYSTEM_PROMPT, rawText, summarySchema);
  return data.summary;
}
