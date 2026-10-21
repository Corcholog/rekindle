import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveTarget } from '../src/evaluator/targetFile';
import { fakeEmbedding, installFakeAi, FakeAi } from './helpers/fakeAi';

// Audit failure scenario 8 (F-13): the LLM supplies a target path outside the project.

describe('resolveTarget', () => {
  const notes = [
    { path: 'ideas.md', title: 'Ideas sueltas' },
    { path: 'research/mechanics.md', title: 'Mecánicas' },
    { path: 'capitulos/uno.md', title: 'Capítulo uno' },
    { path: 'otros/uno.md', title: 'Otro uno' },
    { path: 'a.md', title: 'Repetido' },
    { path: 'b.md', title: 'Repetido' },
  ];
  const existing = (path: string) => ({ path, isNew: false });

  it.each([
    ['ideas.md', 'ideas.md'],
    ['research/mechanics.md', 'research/mechanics.md'],
    ['research/mechanics', 'research/mechanics.md'],
    ['./ideas.md', 'ideas.md'],
    ['research\\mechanics.md', 'research/mechanics.md'],
    ['Research/Mechanics.md', 'research/mechanics.md'], // case differs
    ['mechanics.md', 'research/mechanics.md'], // unique file name
    ['Mecánicas', 'research/mechanics.md'], // a title from the index
    ['capítulo uno', 'capitulos/uno.md'],
    ['uno.md', 'fallback.md'], // two notes share the name
    ['Repetido', 'fallback.md'], // two notes share the title
    ['../../Personal/diario.md', 'fallback.md'],
    ['research/../../../.env', 'fallback.md'],
    ['/etc/passwd', 'fallback.md'],
    ['research/%', 'fallback.md'],
    ['inventada.md', 'fallback.md'], // not in the project and not proposed as new
    ['', 'fallback.md'],
    [null, 'fallback.md'],
  ])('existing %j -> %s', (proposed, expected) => {
    expect(resolveTarget(proposed, false, notes, 'fallback.md')).toEqual(existing(expected));
  });

  it.each([
    ['contraargumentos.md', 'contraargumentos.md'],
    ['contraargumentos', 'contraargumentos.md'],
    ['research/fuentes nuevas', 'research/fuentes nuevas.md'], // a folder that already holds notes
    ['Ideas.md', null], // an existing note, whatever the flag says
    ['Ideas sueltas', null],
  ])('new %j -> %s', (proposed, expected) => {
    const target = resolveTarget(proposed, true, notes, 'fallback.md');
    if (expected) expect(target).toEqual({ path: expected, isNew: true });
    else expect(target.isNew).toBe(false);
  });

  it.each([
    '../fuera.md', '/absoluta.md', 'C:/windows.md', 'carpeta-nueva/nota.md', '.oculta.md', 'research/.oculta.md',
    'con [[corchetes]].md', 'con|barra.md', 'con#almohadilla.md', 'con^circunflejo.md', 'linea\nnueva.md',
    `${'x'.repeat(130)}.md`, 'research//doble.md', 'research/ espacio.md',
  ])('rejects the new note %j', proposed => {
    expect(resolveTarget(proposed, true, notes, 'fallback.md')).toEqual(existing('fallback.md'));
  });

  it('points at no note when retrieval matched no note', () => {
    expect(resolveTarget('../x.md', false, notes, null)).toEqual(existing('unknown'));
  });
});

describe('Failure scenario 8: target paths from the model', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let fake: FakeAi;
  let vault: string;

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
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-target-'));
  }, 120000);

  afterAll(async () => {
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedProject(folder: string, notes: Array<{ notePath: string; text: string; title?: string }>) {
    const [project] = await db.insert(schema.projects).values({ folderPath: folder, title: folder }).returning();
    const vector = fakeEmbedding(notes.map(n => n.text).join(' '));
    const [snapshot] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: folder, thesisText: 'Tesis', embedding: vector, embeddingModel: 'bge-m3',
    }).returning();
    const noteRows = await db.insert(schema.projectNoteSnapshots).values(notes.map(n => ({
      projectSnapshotId: snapshot.id, projectId: project.id, notePath: n.notePath, noteTitle: n.title ?? n.notePath,
      contentSnippet: n.text, embedding: fakeEmbedding(n.text), embeddingModel: 'bge-m3',
    }))).returning();
    return { project, snapshot, noteRows };
  }

  it('stores the matched note instead of a path outside the project, and accepting writes only suggestions.md', async () => {
    const { project, noteRows } = await seedProject('Projects/Faro', [
      { notePath: 'capitulos/tormenta.md', text: 'farero tormenta naufragio faro costa' },
      { notePath: 'ideas.md', text: 'ideas sueltas personajes' },
    ]);
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/faros', summary: 'Resumen', ingestStatus: 'ready',
      embedding: noteRows[0].embedding, embeddingModel: 'bge-m3',
    }).returning();
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Relacionado.',
      action: { actionType: 'evidence_citation', observation: 'Dato.', suggestedAction: 'Citar.', targetFile: '../../Personal/diario.md' },
    });

    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(content.id, project.id);

    const { eq } = await import('drizzle-orm');
    const [suggestion] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, content.id));
    expect(suggestion.targetFile).toBe('capitulos/tormenta.md');

    // Accept: the callout goes to <project>/suggestions.md and nowhere else
    await fs.mkdir(path.join(vault, 'Projects', 'Faro'), { recursive: true });
    await db.update(schema.actionSuggestions).set({ status: 'accepted', resolvedAt: new Date() }).where(eq(schema.actionSuggestions.id, suggestion.id));
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    await writeAcceptedSuggestionToVault(suggestion.id, vault);

    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full); else files.push(path.relative(vault, full));
      }
    };
    await walk(vault);
    expect(files).toEqual([path.join('Projects', 'Faro', 'suggestions.md')]);
    await expect(fs.access(path.join(vault, '..', 'Personal'))).rejects.toThrow();
  });

  it('shows the model every note, and stores the note it names by title even when it is not the closest', async () => {
    const { project, noteRows } = await seedProject('Projects/Ensayo', [
      { notePath: 'borrador.md', text: 'atencion distraccion pantallas borrador ensayo', title: 'Borrador' },
      { notePath: 'research/ejemplos.md', text: 'ejemplos casos estudios', title: 'Ejemplos para el ensayo' },
    ]);
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/atencion', summary: 'Resumen', ingestStatus: 'ready',
      embedding: noteRows[0].embedding, embeddingModel: 'bge-m3',
    }).returning();
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Relacionado.',
      action: { actionType: 'evidence_citation', observation: 'Dato.', suggestedAction: 'Añadir un ejemplo.', targetFile: 'Ejemplos para el ensayo', targetIsNew: false },
    });

    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(content.id, project.id);

    const user = fake.calls.filter(c => c.kind === 'triage').at(-1)!.user;
    expect(user).toContain('- borrador.md — "Borrador"');
    expect(user).toContain('- research/ejemplos.md — "Ejemplos para el ensayo"');
    expect(user).toContain('NOTA MÁS CERCANA AL ARTÍCULO (orientativa, no obligatoria): borrador.md');
    const { eq } = await import('drizzle-orm');
    const [suggestion] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, content.id));
    expect(suggestion).toMatchObject({ targetFile: 'research/ejemplos.md', targetIsNew: false });
    // The evaluation keeps the closest note, for accepting a tentative verdict later
    const [evaluation] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, suggestion.evaluationId));
    expect(evaluation.matchedNotePath).toBe('borrador.md');
  });

  it('stores a proposed new note without creating it, and accepting links to it from suggestions.md', async () => {
    const { project, noteRows } = await seedProject('Projects/Nueva', [
      { notePath: 'borrador.md', text: 'inteligencia artificial agentes modelos', title: 'Borrador' },
    ]);
    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/criticas', title: 'Críticas', summary: 'Resumen', ingestStatus: 'ready',
      embedding: noteRows[0].embedding, embeddingModel: 'bge-m3',
    }).returning();
    fake.answerNext({
      verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Aporta críticas.',
      action: { actionType: 'counter_argument', observation: 'Críticas.', suggestedAction: 'Abrir una nota de críticas.', targetFile: 'Críticas a la IA', targetIsNew: true },
    });

    const { evaluateContentMatch } = await import('../src/evaluator');
    await evaluateContentMatch(content.id, project.id);

    const { eq } = await import('drizzle-orm');
    const [suggestion] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, content.id));
    expect(suggestion).toMatchObject({ targetFile: 'Críticas a la IA.md', targetIsNew: true });

    const projectDir = path.join(vault, 'Projects', 'Nueva');
    await fs.mkdir(projectDir, { recursive: true });
    await db.update(schema.actionSuggestions).set({ status: 'accepted', resolvedAt: new Date() }).where(eq(schema.actionSuggestions.id, suggestion.id));
    const { writeAcceptedSuggestionToVault } = await import('../src/vault/updater');
    await writeAcceptedSuggestionToVault(suggestion.id, vault);
    await writeAcceptedSuggestionToVault(suggestion.id, vault); // a retry adds nothing (I5)

    expect(await fs.readdir(projectDir)).toEqual(['suggestions.md']);
    const written = await fs.readFile(path.join(projectDir, 'suggestions.md'), 'utf-8');
    expect(written.match(/\[\[Projects\/Nueva\/Críticas a la IA\|Críticas a la IA\]\]/g)).toHaveLength(1);
    expect(written).toMatch(/Nota nueva sugerida|Suggested new note/);
  });

  it('a stored target file with LIKE wildcards does not match unrelated notes in the staleness check', async () => {
    const { project, snapshot } = await seedProject('Projects/Atlas', [
      { notePath: 'mapas/costas.md', text: 'mapas costas litoral' },
      { notePath: 'notas/rios.md', text: 'rios caudal cuencas' },
    ]);
    const [content] = await db.insert(schema.contents).values({ uri: 'https://example.com/atlas', summary: 'Resumen', ingestStatus: 'ready' }).returning();
    const [evaluation] = await db.insert(schema.evaluations).values({
      contentId: content.id, projectSnapshotId: snapshot.id, verdict: 'actionable', consumptionSeq: 1,
    }).returning();
    // A row written before validation: the model's "%" became the target file
    const [suggestion] = await db.insert(schema.actionSuggestions).values({
      evaluationId: evaluation.id, projectId: project.id, contentId: content.id, actionType: 'other',
      targetFile: '%', observation: 'Obs', suggestedAction: 'Acción', status: 'pending',
    }).returning();

    // A newer snapshot where only notas/rios.md changed a lot (the project vector is unchanged, so
    // only the note-level check could flag it)
    const [latest] = await db.insert(schema.projectSnapshots).values({
      projectId: project.id, treeHash: 'Atlas-2', thesisText: 'Tesis', embedding: snapshot.embedding, embeddingModel: 'bge-m3',
      capturedAt: new Date(Date.now() + 1000),
    }).returning();
    await db.insert(schema.projectNoteSnapshots).values([
      { projectSnapshotId: latest.id, projectId: project.id, notePath: 'mapas/costas.md', noteTitle: 'mapas/costas.md', embedding: fakeEmbedding('mapas costas litoral'), embeddingModel: 'bge-m3' },
      { projectSnapshotId: latest.id, projectId: project.id, notePath: 'notas/rios.md', noteTitle: 'notas/rios.md', embedding: fakeEmbedding('volcanes lava erupciones'), embeddingModel: 'bge-m3' },
    ]);

    const Fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const server = Fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/suggestions')).default);
    const res = await server.inject({ method: 'GET', url: `/api/suggestions?status=pending&projectId=${project.id}` });
    await server.close();

    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: any) => i.id === suggestion.id);
    expect(item).toBeDefined();
    expect(item.isStale).toBe(false);
    expect(item.driftScore).toBe(0);
  });
});
