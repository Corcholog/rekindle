import { describe, it, expect, vi, afterAll } from 'vitest';

// A clip's text comes from the client (the extension sends the selection) and from pages Rekindle
// does not control; nothing past MAX_ARTICLE_CHARS may reach a paid model.
describe('article size limits', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:9/none');
  afterAll(() => { vi.unstubAllEnvs(); });

  it('cuts the selection and the combined clip text', async () => {
    const { clipText } = await import('../src/workers/ingestionWorker');
    const { MAX_ARTICLE_CHARS } = await import('../src/config');
    const huge = 'cita '.repeat(MAX_ARTICLE_CHARS);

    // Nothing extracted: the selection alone, cut
    expect(clipText(null, huge)).toHaveLength(MAX_ARTICLE_CHARS);
    expect(clipText('', '  ')).toBeNull();
    // Article and a selection it lacks: the selection first, the whole thing cut
    const both = clipText('artículo '.repeat(10_000), huge)!;
    expect(both.startsWith('[Cita seleccionada por el usuario]:\ncita')).toBe(true);
    expect(both).toHaveLength(MAX_ARTICLE_CHARS);
    // A selection the article already contains is not repeated
    expect(clipText('Un artículo sobre faros y tormentas.', 'faros y tormentas')).toBe('Un artículo sobre faros y tormentas.');
    expect(clipText('Corto.', 'Otra cosa.')).toBe('[Cita seleccionada por el usuario]:\nOtra cosa.\n\n---\n\nCorto.');
  });

  it('the summarizer never sends more than the limit, whatever its caller passes', async () => {
    const { summarizeText } = await import('../src/ai/summarize');
    const { MAX_ARTICLE_CHARS } = await import('../src/config');
    let sent = '';
    const ai = { evaluateContent: async (_system: string, user: string) => { sent = user; return { data: { summary: 'ok' } }; } } as any;
    await summarizeText(ai, `${'a'.repeat(MAX_ARTICLE_CHARS)}MAS-ALLA-DEL-LIMITE`);
    expect(sent).toContain('a'.repeat(1000));
    expect(sent).not.toContain('MAS-ALLA-DEL-LIMITE');
  });

  it('rejects an ingest request larger than the body limit before parsing it', async () => {
    const { MAX_INGEST_BODY_BYTES } = await import('../src/config');
    const Fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const server = Fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/ingest')).default);
    const res = await server.inject({
      method: 'POST', url: '/api/ingest', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/a', selection: 'x'.repeat(MAX_INGEST_BODY_BYTES) }),
    });
    await server.close();
    expect(res.statusCode).toBe(413);
  });

  it('the extension cuts selections to the same limit before sending', async () => {
    const fs = await import('fs/promises');
    const { MAX_ARTICLE_CHARS } = await import('../src/config');
    for (const file of ['extension/background.js', 'extension/popup.js']) {
      const source = await fs.readFile(file, 'utf-8');
      expect(source, file).toContain(`const MAX_SELECTION_CHARS = ${MAX_ARTICLE_CHARS};`);
      expect(source.match(/\.slice\(0, MAX_SELECTION_CHARS\)/g)!.length, file).toBeGreaterThanOrEqual(2);
    }
    expect(await fs.readFile('extension/popup.html', 'utf-8')).toContain(`maxlength="${MAX_ARTICLE_CHARS}"`);
  });
});
