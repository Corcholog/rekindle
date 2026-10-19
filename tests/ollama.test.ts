import { describe, it, expect, beforeAll } from 'vitest';
import { AiProvider } from '../src/ai/aiProvider';
import { z } from 'zod';

// Live check against a local Ollama with bge-m3 and qwen2.5:7b-instruct. Opt-in, like the cloud
// checks: REKINDLE_LIVE_TESTS=1 pnpm test. The rest of the suite uses tests/helpers/fakeAi.ts.
describe.skipIf(process.env.REKINDLE_LIVE_TESTS !== '1')('AiProvider Integration (live Ollama)', () => {
  let provider: AiProvider;

  beforeAll(() => {
    provider = new AiProvider('http://127.0.0.1:11434');
  });

  it('debería obtener un vector de embedding (1024D) de bge-m3', async () => {
    const text = 'Este es un texto de prueba para generar embeddings en español.';
    const vector = await provider.getEmbedding(text);
    
    expect(vector).toBeDefined();
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBe(1024); // bge-m3 dimensions
  }, 120000); // 120s timeout in case of model pulling / cold start

  it('debería generar una respuesta JSON estructurada con qwen2.5:7b-instruct', async () => {
    const schema = z.object({
      verdict: z.enum(['irrelevant', 'tentative', 'actionable']),
      confidenceScore: z.number().min(0).max(1),
      reasoning: z.string()
    });

    const systemPrompt = `Eres un asistente evaluador. Evalúa el siguiente texto e indica si es accionable. 
Debes responder SIEMPRE en formato JSON.`;
    
    const userText = 'El nuevo framework de frontend añade view transitions nativos que podemos aplicar a la UI del dashboard.';

    const { data: result, model } = await provider.evaluateContent(systemPrompt, userText, schema);

    expect(result).toBeDefined();
    expect(result.verdict).toBeDefined();
    expect(typeof result.confidenceScore).toBe('number');
    expect(typeof result.reasoning).toBe('string');
    expect(typeof model).toBe('string');
  }, 120000); // 120s timeout
});
