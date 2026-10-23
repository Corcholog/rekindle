import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// F-14: synergies compared and quoted notes from any snapshot of a project, deleted notes included.
// The research brief sent every accepted suggestion, however many.

const DIMENSIONS = 1024;
const axis = (i: number) => Array.from({ length: DIMENSIONS }, (_, j) => (j === i ? 1 : 0));

describe('synergies use current notes; the brief has a bounded prompt', () => {
  let container: StartedPostgreSqlContainer;
  let server: any;
  let db: any;
  let schema: any;
  let fake: FakeAi;
  let projectA: any;
  let projectB: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    vi.stubEnv('VAULT_PATH', '');
    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);

    [projectA] = await db.insert(schema.projects).values({ folderPath: 'Projects/A', title: 'A' }).returning();
    [projectB] = await db.insert(schema.projects).values({ folderPath: 'Projects/B', title: 'B' }).returning();
    // A's old snapshot had a note identical to B's; it was deleted, and A's current note is elsewhere
    const [oldA] = await db.insert(schema.projectSnapshots).values({
      projectId: projectA.id, treeHash: 'a-old', thesisText: 'A', embedding: axis(1), embeddingModel: 'bge-m3', capturedAt: new Date(Date.now() - 60_000),
    }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: oldA.id, projectId: projectA.id, notePath: 'borrada.md', noteTitle: 'NOTA-BORRADA', contentSnippet: 'TEXTO-BORRADO', embedding: axis(5), embeddingModel: 'bge-m3',
    });
    const [newA] = await db.insert(schema.projectSnapshots).values({ projectId: projectA.id, treeHash: 'a', thesisText: 'A', embedding: axis(1), embeddingModel: 'bge-m3' }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: newA.id, projectId: projectA.id, notePath: 'actual.md', noteTitle: 'NOTA-ACTUAL', contentSnippet: 'TEXTO-ACTUAL',
      embedding: axis(1).map((v, i) => (i === 5 ? 0.6 : v * 0.8)), embeddingModel: 'bge-m3',
    });
    const [snapB] = await db.insert(schema.projectSnapshots).values({ projectId: projectB.id, treeHash: 'b', thesisText: 'B', embedding: axis(1), embeddingModel: 'bge-m3' }).returning();
    await db.insert(schema.projectNoteSnapshots).values({
      projectSnapshotId: snapB.id, projectId: projectB.id, notePath: 'b.md', noteTitle: 'NOTA-B', contentSnippet: 'TEXTO-B', embedding: axis(5), embeddingModel: 'bge-m3',
    });

    server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/projects')).default);
    await server.ready();
  }, 120000);

  afterAll(async () => {
    await server?.close();
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it('synergies list and bridge only the latest snapshot notes (F-14)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects/synergies?minSimilarity=0' });
    expect(res.statusCode).toBe(200);
    const synergy = res.json().synergies[0];
    const titles = synergy.closestNotes.flatMap((n: any) => [n.noteATitle, n.noteBSTitle]);
    expect(titles).toContain('NOTA-ACTUAL');
    expect(titles).not.toContain('NOTA-BORRADA');

    fake.answerNext({ bridgeTitle: 'Puente', overview: 'o', sharedProblems: ['p'], mutualBenefits: ['m'], markdownContent: 'c' });
    const bridge = await server.inject({ method: 'POST', url: '/api/projects/synergies/explore', payload: { projectAId: projectA.id, projectBId: projectB.id } });
    expect(bridge.statusCode).toBe(200);
    const prompt = fake.calls.at(-1)!.user;
    expect(prompt).toContain('TEXTO-ACTUAL');
    expect(prompt).not.toContain('TEXTO-BORRADO');
  });

  it('the research brief sends the most recent accepted suggestions, up to its limits', async () => {
    const { SYNTHESIS_MAX_SUGGESTIONS, SYNTHESIS_SUGGESTIONS_CHARS } = await import('../src/config');
    const [content] = await db.insert(schema.contents).values({ uri: 'https://example.com/a', ingestStatus: 'ready', title: 'Fuente' }).returning();
    const [snapshot] = await db.select().from(schema.projectSnapshots).where((await import('drizzle-orm')).eq(schema.projectSnapshots.treeHash, 'a'));
    for (let i = 0; i < 60; i++) {
      const [ev] = await db.insert(schema.evaluations).values({ contentId: content.id, projectSnapshotId: snapshot.id, verdict: 'actionable', consumptionSeq: i + 1 }).returning();
      await db.insert(schema.actionSuggestions).values({
        evaluationId: ev.id, projectId: projectA.id, contentId: content.id, actionType: 'other', targetFile: 'actual.md',
        observation: `OBS-${String(i).padStart(2, '0')} ${'texto '.repeat(150)}`, suggestedAction: `ACCION-${String(i).padStart(2, '0')}`,
        status: 'accepted', resolvedAt: new Date(Date.now() - (60 - i) * 1000),
      });
    }
    fake.answerNext({ title: 'Brief', executiveSummary: 'r', markdownContent: 'c', suggestedNextSteps: ['s'] });
    const res = await server.inject({ method: 'POST', url: `/api/projects/${projectA.id}/synthesize` });
    expect(res.statusCode).toBe(200);
    expect(res.json().acceptedCount).toBe(60);
    const prompt = fake.calls.at(-1)!.user;
    const included = [...prompt.matchAll(/ACCION-(\d\d)/g)].map(m => Number(m[1]));
    // Newest first, never more than the count limit, and the prompt says it is a selection
    expect(included[0]).toBe(59);
    expect(included.length).toBeLessThanOrEqual(SYNTHESIS_MAX_SUGGESTIONS);
    expect(included).not.toContain(0);
    expect(prompt).toContain(`Total de sugerencias aceptadas: 60 (se incluyen las ${included.length} más recientes)`);
    const block = prompt.slice(prompt.indexOf('[Sugerencia 1'));
    expect(block.length).toBeLessThan(SYNTHESIS_SUGGESTIONS_CHARS + 500);
  });
});
