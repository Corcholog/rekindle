import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// Some links cannot be read: a PDF, a blocked site, a page built by scripts. Each failure gets a
// code the UI explains, and the owner can paste the text instead; the page is then never fetched.

describe('classifying ingest failures', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:9/none');

  it('maps each failure to the code the UI explains', async () => {
    const { classifyIngestFailure } = await import('../src/workers/ingestFailure');
    const cases: Array<[string, string, string?]> = [
      ['Unsupported content type "application/pdf". Only HTML or text web pages are supported.', 'pdf'],
      ['Unsupported content type "application/octet-stream". Only HTML or text web pages are supported.', 'pdf', 'https://x.org/informe.pdf'],
      ['Unsupported content type "image/png". Only HTML or text web pages are supported.', 'unsupported_type'],
      ['Too little text extracted (120 characters)', 'too_little_text'],
      ['Failed to fetch URL: 403 Forbidden', 'blocked'],
      ['Failed to fetch URL: 404 Not Found', 'not_found'],
      ['Failed to fetch URL: 500 Internal Server Error', 'fetch_failed'],
      ['No subtitles or transcript are available for this YouTube video', 'no_transcript'],
      ['Readability failed to extract text content', 'no_text'],
      ['Access denied (SSRF): local or private addresses cannot be ingested (10.0.0.1).', 'not_allowed'],
      ['El proveedor de IA no respondió', 'other'],
    ];
    for (const [message, kind, url] of cases) expect(classifyIngestFailure(message, url), message).toBe(kind);
  });
});

describe('pasting the text of a link Rekindle could not read', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let boss: any;
  let schema: any;
  let fake: FakeAi;
  const fetched: string[] = [];
  const PAGES: Record<string, () => Response> = {
    'https://revista.example.org/informe.pdf': () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    'https://revista.example.org/muro': () => new Response('<html><body><article><p>Acepta las cookies para seguir leyendo.</p></article></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return (PAGES[url] ?? (() => new Response('no', { status: 404 })))();
    });

    const queue = await import('../src/queue/index');
    boss = queue.boss;
    await queue.startQueue();
    await (await import('../src/workers/ingestionWorker')).setupIngestionWorker();

    server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/ingest')).default);
    server.register((await import('../src/api/routes/contents')).default);
    await server.ready();
  }, 180000);

  afterAll(async () => {
    await server?.close();
    if (boss) await boss.stop({ graceful: false });
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const settled = async (contentId: string) => {
    const { eq } = await import('drizzle-orm');
    for (let i = 0; i < 120; i++) {
      const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
      if (row && (row.ingestStatus === 'ready' || row.ingestStatus === 'failed')) return row;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('ingest did not settle');
  };
  const ingest = (payload: Record<string, string>) => server.inject({ method: 'POST', url: '/api/ingest', payload });

  it('a PDF fails as pdf, and its pasted text is analyzed without fetching the page again', async () => {
    const created = await ingest({ url: 'https://revista.example.org/informe.pdf' });
    const failed = await settled(created.json().contentId);
    expect(failed).toMatchObject({ ingestStatus: 'failed', ingestFailureKind: 'pdf', pastedText: false });

    const listed = (await server.inject({ method: 'GET', url: '/api/contents?status=failed' })).json().items;
    expect(listed.find((i: any) => i.id === failed.id)).toMatchObject({ ingestFailureKind: 'pdf', pastedText: false });

    const before = fetched.length;
    const pasted = `${'Texto del informe sobre faros y tormentas. '.repeat(30)}FIN`;
    const res = await server.inject({ method: 'POST', url: `/api/contents/${failed.id}/text`, payload: { text: `  ${pasted}  ` } });
    expect(res.statusCode).toBe(200);
    const ready = await settled(failed.id);
    expect(ready).toMatchObject({ ingestStatus: 'ready', pastedText: true, ingestFailureKind: null, rawText: pasted });
    expect(ready.summary).toContain('Resumen simulado');
    expect(fetched.length).toBe(before);
  }, 60000);

  it('a page that returns almost no text is held as too_little_text', async () => {
    const created = await ingest({ url: 'https://revista.example.org/muro' });
    expect(await settled(created.json().contentId)).toMatchObject({ ingestStatus: 'failed', ingestFailureKind: 'too_little_text' });
  }, 60000);

  it('a selection sent with an unreadable link becomes the article', async () => {
    const selection = 'Una cita del PDF que el dueño copió desde el visor del navegador, sobre faros.';
    const created = await ingest({ url: 'https://revista.example.org/otro.pdf', selection });
    expect(await settled(created.json().contentId)).toMatchObject({ ingestStatus: 'ready', rawText: selection });
  }, 60000);

  it('text sent with a new link is used as is, and the page is never fetched', async () => {
    const before = fetched.length;
    const created = await ingest({ url: 'https://revista.example.org/nunca', text: 'Texto pegado al guardar el enlace, sobre faros y naufragios.' });
    expect(created.statusCode).toBe(202);
    expect(await settled(created.json().contentId)).toMatchObject({ ingestStatus: 'ready', pastedText: true, rawText: 'Texto pegado al guardar el enlace, sobre faros y naufragios.' });
    expect(fetched.length).toBe(before);
  }, 60000);

  it('only a failed item takes pasted text, and the text is cut at the article limit', async () => {
    const { MAX_ARTICLE_CHARS } = await import('../src/config');
    const { eq } = await import('drizzle-orm');
    const [ready] = await db.select().from(schema.contents).where(eq(schema.contents.uri, 'https://revista.example.org/nunca'));
    const conflict = await server.inject({ method: 'POST', url: `/api/contents/${ready.id}/text`, payload: { text: 'otro texto' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('not_failed');
    expect((await server.inject({ method: 'POST', url: '/api/contents/00000000-0000-0000-0000-000000000000/text', payload: { text: 'x' } })).statusCode).toBe(404);
    const [held] = await db.select().from(schema.contents).where(eq(schema.contents.uri, 'https://revista.example.org/muro'));
    expect((await server.inject({ method: 'POST', url: `/api/contents/${held.id}/text`, payload: { text: '   ' } })).statusCode).toBe(400);

    const long = await server.inject({ method: 'POST', url: `/api/contents/${held.id}/text`, payload: { text: 'faro '.repeat(MAX_ARTICLE_CHARS) } });
    expect(long.statusCode).toBe(200);
    expect((await settled(held.id)).rawText.length).toBe(MAX_ARTICLE_CHARS);
  }, 60000);
});
