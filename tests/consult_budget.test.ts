import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// The Consultor used to send the whole library and every note on each question. It now sends the
// items and notes closest to the question, each cut, so the prompt has a fixed upper size.

const DIMENSIONS = 1024;
/** A unit vector at cosine distance `distance` from the first axis, leaning towards axis `axis`. */
function vectorAt(distance: number, axis: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const similarity = 1 - distance;
  v[0] = similarity;
  v[axis] = Math.sqrt(1 - similarity * similarity);
  return v;
}
const pad = (n: number) => String(n).padStart(2, '0');
const long = (tag: string) => `${tag} ${'texto largo '.repeat(300)}FIN-${tag}`; // about 3,600 characters

describe('Consultor budget', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let ai: any;
  const prompts: Array<{ system: string; user: string }> = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    const { db, pool } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    const schema = await import('../src/db/schema');

    // Library: 20 comparable items at distances 0.01 to 0.20, plus three that never reach the prompt
    for (let i = 1; i <= 20; i++) {
      await db.insert(schema.contents).values({
        uri: `https://example.com/a${i}`, title: i === 15 ? `A15${' título larguísimo'.repeat(100)}` : `A${pad(i)}`, summary: long(`RESUMEN-A${pad(i)}`), ingestStatus: 'ready',
        embedding: vectorAt(i / 100, i), embeddingModel: 'bge-m3',
      });
    }
    await db.insert(schema.contents).values([
      { uri: 'https://example.com/otro', title: 'OTRO-MODELO', summary: 'x', ingestStatus: 'ready', embedding: vectorAt(0.001, 50), embeddingModel: 'otro-modelo' },
      { uri: 'https://example.com/sin', title: 'SIN-EMBEDDING', summary: 'x', ingestStatus: 'ready' },
      { uri: 'https://example.com/fallo', title: 'FALLIDO', ingestStatus: 'failed', embedding: vectorAt(0.001, 51), embeddingModel: 'bge-m3' },
    ]);

    // An active project with 20 notes at distances 0.02 to 0.40, and a closer note in an older snapshot
    const [p] = await db.insert(schema.projects).values({ folderPath: 'Projects/P', title: 'P' }).returning();
    const [older] = await db.insert(schema.projectSnapshots).values({
      projectId: p.id, treeHash: 'p-old', notesContent: 'viejo', embedding: vectorAt(0.5, 60), embeddingModel: 'bge-m3',
      capturedAt: new Date(Date.now() - 60_000),
    }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: older.id, projectId: p.id, notePath: 'vieja.md', noteTitle: 'NOTA-VIEJA', contentSnippet: 'NOTA-VIEJA',
      embedding: vectorAt(0, 61), embeddingModel: 'bge-m3',
    });
    const [latest] = await db.insert(schema.projectSnapshots).values({
      projectId: p.id, treeHash: 'p', notesContent: 'notas', embedding: vectorAt(0.5, 62), embeddingModel: 'bge-m3',
    }).returning();
    for (let i = 1; i <= 20; i++) {
      await db.insert(schema.projectNoteSnapshots).values({
        projectSnapshotId: latest.id, projectId: p.id, notePath: `n${pad(i)}.md`, noteTitle: `N${pad(i)}`, contentSnippet: long(`NOTA-N${pad(i)}`),
        embedding: vectorAt(i / 50, 100 + i), embeddingModel: 'bge-m3',
      });
    }
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: latest.id, projectId: p.id, notePath: 'otro.md', noteTitle: 'NOTA-OTRO-MODELO', contentSnippet: 'x',
      embedding: vectorAt(0, 130), embeddingModel: 'otro-modelo',
    });
    // An inactive project with a note right on the question
    const [q] = await db.insert(schema.projects).values({ folderPath: 'Projects/Q', title: 'Q', isActive: false }).returning();
    const [qs] = await db.insert(schema.projectSnapshots).values({ projectId: q.id, treeHash: 'q', notesContent: 'q' }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: qs.id, projectId: q.id, notePath: 'q.md', noteTitle: 'NOTA-INACTIVA', contentSnippet: 'NOTA-INACTIVA',
      embedding: vectorAt(0, 140), embeddingModel: 'bge-m3',
    });
    // An active project from older data: a snapshot without note rows, ranked by its project embedding
    const [r] = await db.insert(schema.projects).values({ folderPath: 'Projects/R', title: 'R' }).returning();
    await db.insert(schema.projectSnapshots).values({
      projectId: r.id, treeHash: 'r', notesContent: 'PROYECTO-SIN-NOTAS', embedding: vectorAt(0.005, 150), embeddingModel: 'bge-m3',
    });

    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    ai = sharedAiProvider;
    ai.setOverrides({
      embed: async () => vectorAt(0, 1), // the question sits on the first axis
      evaluate: async (system: string, user: string, schema: any) => {
        prompts.push({ system, user });
        const answer = { diagnosis: 'Según [C1] y [N1].', projectViability: null, matchedContents: [{ refId: 'C1', whyItConnects: 'cerca' }], matchedNotes: [{ refId: '[n2]', whyItConnects: 'cerca' }] };
        return { data: schema.parse(answer), model: 'fake:x', latencyMs: 1, attempts: [] };
      },
    });

    const Fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    server = Fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/library')).default);
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    ai?.setOverrides({});
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  const consult = (query: string) => server.inject({ method: 'POST', url: '/api/library/consult', payload: { query } });

  it('sends only the closest items and notes, closest first, each cut', async () => {
    const { CONSULT_TOP_CONTENTS, CONSULT_TOP_NOTES, MAX_CONSULT_QUERY_CHARS } = await import('../src/config');
    const res = await consult('q'.repeat(MAX_CONSULT_QUERY_CHARS));
    expect(res.statusCode).toBe(200);
    const { user } = prompts.at(-1)!;

    const sentItems = [...user.matchAll(/Título: "(A\d\d)/g)].map(m => m[1]);
    expect(sentItems).toEqual(Array.from({ length: CONSULT_TOP_CONTENTS }, (_, i) => `A${pad(i + 1)}`));
    // The project without note rows is the closest entry, then the latest snapshot's notes in order
    const sentNotes = [...user.matchAll(/Archivo de Nota: "([^"]+)"/g)].map(m => m[1]);
    expect(sentNotes).toEqual(['R.md', ...Array.from({ length: CONSULT_TOP_NOTES - 1 }, (_, i) => `n${pad(i + 1)}.md`)]);
    expect(user).toContain('PROYECTO-SIN-NOTAS');
    for (const absent of ['OTRO-MODELO', 'SIN-EMBEDDING', 'FALLIDO', 'NOTA-VIEJA', 'NOTA-OTRO-MODELO', 'NOTA-INACTIVA']) expect(user).not.toContain(absent);
    // Summaries and notes are cut before their end
    expect(user).toContain('RESUMEN-A01 texto largo');
    expect(user).not.toContain('FIN-RESUMEN-A01');
    expect(user).not.toContain('FIN-NOTA-N01');
    // Long items and the longest question still fit the stated upper size
    expect(user).toContain(`A15${' título larguísimo'.repeat(100)}`.substring(0, 300) + '"');
    expect(prompts.at(-1)!.system.length + user.length).toBeLessThan(63_000);
    // The model is told it sees a selection, and of how much
    expect(user).toContain('Recibes los 15 contenidos más cercanos a la consulta, de 22 en la biblioteca, y las 15 notas más cercanas, de 22 en los proyectos activos.');

    const body = res.json();
    expect(body).toMatchObject({ totalLibraryEvaluated: 15, totalLibrary: 22, totalNotesEvaluated: 15, totalNotes: 22 });
    expect(body.matchedContents.map((c: any) => c.title)).toEqual(['A01']);
    expect(body.matchedNotes.map((n: any) => n.notePath)).toEqual(['n01.md']);
  });

  it('rejects a question over the limit before any model call', async () => {
    const { MAX_CONSULT_QUERY_CHARS } = await import('../src/config');
    const before = prompts.length;
    const res = await consult('q'.repeat(MAX_CONSULT_QUERY_CHARS + 1));
    expect(res.statusCode).toBe(400);
    expect(prompts.length).toBe(before);
  });

  it('the question box has the same limit', async () => {
    const fs = await import('fs/promises');
    const { MAX_CONSULT_QUERY_CHARS } = await import('../src/config');
    expect(await fs.readFile('web/src/views/Consultant.tsx', 'utf-8')).toContain(`const MAX_QUERY_CHARS = ${MAX_CONSULT_QUERY_CHARS};`);
  });

  it('answers with embedding_failed when the local embedding model is down', async () => {
    const evaluate = vi.fn();
    ai.setOverrides({ embed: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }, evaluate });
    const res = await consult('faros');
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('embedding_failed');
    expect(res.payload).not.toContain('ECONNREFUSED');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
