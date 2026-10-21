import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// After triage, a second call lays out what the model wrote: the action as a headline and checked
// steps, the reasoning as a connection and what is missing. triage_reasoning keeps the model's text.

const notes = [
  { path: 'draft.md', title: 'Borrador' },
  { path: 'research/autores.md', title: 'Autores y conceptos' },
];

describe('suggestion text laid out by a second call', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let fake: FakeAi;

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
  }, 120000);

  afterAll(async () => {
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  async function seed(name: string) {
    const vector = new Array(1024).fill(0).map((_, i) => (i === 3 ? 1 : 0));
    const [project] = await db.insert(schema.projects).values({ folderPath: `Projects/${name}`, title: name }).returning();
    const [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: name, thesisText: 'Tesis', embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    for (const note of notes) {
      await db.insert(schema.projectNoteSnapshots).values({
        projectSnapshotId: snapshot.id, projectId: project.id, notePath: note.path, noteTitle: note.title,
        contentSnippet: note.title, embedding: vector, embeddingModel: 'bge-m3',
      });
    }
    const [content] = await db.insert(schema.contents).values({
      uri: `https://example.com/${name}`, summary: 'Resumen', embedding: vector, embeddingModel: 'bge-m3', ingestStatus: 'ready',
    }).returning();
    return content.id as string;
  }

  it('lays out an actionable answer as steps in a second call, and keeps the model reasoning', async () => {
    const contentId = await seed('Acciones');
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'El artículo trata de Sartre. Amplía la viñeta de Sartre en Autores y conceptos.',
      action: {
        actionType: 'evidence_citation', observation: 'Da una formulación citable.',
        suggestedAction: "En 'Autores y conceptos', ampliar la viñeta de Sartre con 'La existencia precede a la esencia.'",
        targetFile: 'research/autores.md',
      },
    });
    fake.answerStructureNext({
      connection: 'Amplía la viñeta de Sartre en Autores y conceptos.', gap: null,
      headline: `Ampliar la viñeta de Sartre ${'muy '.repeat(200)}`,
      steps: [{ note: 'Autores y conceptos', where: 'Sartre', change: 'Ampliar la viñeta.', text: 'La existencia precede a la esencia.' }],
    });
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(contentId);

    // The second call saw the model's own text and the note index, not the verdict
    const structureCall = fake.structureCalls.at(-1)!;
    expect(structureCall.user).toContain('<RAZONAMIENTO>');
    expect(structureCall.user).toContain('ampliar la viñeta de Sartre');
    expect(structureCall.user).toContain('- research/autores.md — "Autores y conceptos"');
    expect(structureCall.user).not.toContain('actionable');

    const [evaluation] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId));
    expect(evaluation).toMatchObject({
      reasoningConnection: 'Amplía la viñeta de Sartre en Autores y conceptos.', reasoningGap: null,
      triageReasoning: 'El artículo trata de Sartre. Amplía la viñeta de Sartre en Autores y conceptos.',
    });
    const [suggestion] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.evaluationId, evaluation.id));
    const { HEADLINE_CHARS } = await import('../src/evaluator/actionSteps');
    expect(suggestion.suggestedAction.length).toBeLessThanOrEqual(HEADLINE_CHARS);
    expect(suggestion.actionSteps).toEqual([{ note: 'research/autores.md', noteIsNew: false, where: 'Sartre', change: 'Ampliar la viñeta.', text: 'La existencia precede a la esencia.' }]);
  }, 60000);

  it('lays out a tentative reasoning, and keeps the plain text when the second call fails', async () => {
    const contentId = await seed('Tentativa');
    fake.answerNext({ verdict: 'tentative', confidenceScore: 0.5, triageReasoning: 'El artículo trata de faros. Toca el Acto 1. Pero no trae datos.', action: null });
    fake.answerStructureNext({ connection: 'Toca el Acto 1 del borrador.', gap: 'No trae datos ni citas nuevas.', headline: null, steps: null });
    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(contentId);
    const [evaluation] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId));
    expect(evaluation).toMatchObject({ verdict: 'tentative', reasoningConnection: 'Toca el Acto 1 del borrador.', reasoningGap: 'No trae datos ni citas nuevas.' });
    expect(fake.structureCalls.at(-1)!.user).not.toContain('<ACCION>');

    // Unscripted, the second call fails: the evaluation and its suggestion keep the triage text
    const plainId = await seed('SinPasos');
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.8, triageReasoning: 'Conecta.',
      action: { actionType: 'other', observation: 'o', suggestedAction: 'Citar en el borrador.', targetFile: 'draft.md' },
    });
    await evaluateContentMatch(plainId);
    const [plainEval] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, plainId));
    expect(plainEval).toMatchObject({ triageReasoning: 'Conecta.', reasoningConnection: null });
    const [plain] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.evaluationId, plainEval.id));
    expect(plain).toMatchObject({ suggestedAction: 'Citar en el borrador.', actionSteps: null });

    // An irrelevant verdict gets no second call
    const before = fake.structureCalls.length;
    const irrelevantId = await seed('Irrelevante');
    fake.answerNext({ verdict: 'irrelevant', confidenceScore: 0.1, triageReasoning: 'Otro tema.', action: null });
    await evaluateContentMatch(irrelevantId);
    expect(fake.structureCalls.length).toBe(before);
  }, 60000);
});
