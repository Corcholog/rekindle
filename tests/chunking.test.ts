import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fakeEmbedding, installFakeAi, FakeAi } from './helpers/fakeAi';

// A long note's later sections were invisible to retrieval: each note was embedded from its first
// 4,000 characters. Long notes are now split where their headings split them, each piece embedded
// with its heading path, and an article can match a project through any section.

const repeat = (words: string, times: number) => Array.from({ length: times }, () => words).join(' ');
const ACT1 = repeat('faro tormenta costa linterna', 120);   // about 3,400 characters
const ACT2 = repeat('barco marea puerto ancla', 90);         // about 2,200 characters
const ACT3 = repeat('volcan erupcion lava magma ceniza crater', 5);
const draft = (act1 = ACT1) => `# Borrador\n\nIntro breve.\n\n## Acto 1\n\n${act1}\n\n## Acto 2\n\n${ACT2}\n\n## Acto 3\n\n${ACT3}\n`;

describe('chunkNote', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:9/none');

  it('leaves a short note alone and splits a long one at its headings', async () => {
    const { chunkNote, CHUNK_CHARS } = await import('../src/vault/chunker');
    expect(chunkNote('Corta', '# Corta\n\nUna nota breve.', 4000)).toEqual([]);

    const chunks = chunkNote('Borrador', draft(), 4000);
    expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]).toMatchObject({ heading: 'Borrador', text: 'Intro breve.' });
    expect(new Set(chunks.map(c => c.heading))).toEqual(new Set(['Borrador', 'Borrador › Acto 1', 'Borrador › Acto 2', 'Borrador › Acto 3']));
    expect(chunks.filter(c => c.heading === 'Borrador › Acto 3').map(c => c.text)).toEqual([ACT3]);
    expect(chunks.every(c => c.text.length <= CHUNK_CHARS)).toBe(true);
    // A long section is cut into several pieces, each starting with the end of the previous one
    const act1 = chunks.filter(c => c.heading === 'Borrador › Acto 1');
    expect(act1.length).toBeGreaterThan(1);
    const tail = act1[0].text.split(' ').slice(-3).join(' ');
    expect(act1[1].text.startsWith(tail)).toBe(true);
  });

  it('keeps text before the first heading, caps heading paths, and hashes the embedding input', async () => {
    const { chunkNote, chunkEmbeddingInput, MAX_HEADING_CHARS } = await import('../src/vault/chunker');
    const long = `${repeat('prologo sin titulo', 300)}\n\n# ${'T'.repeat(500)}\n\n${repeat('cuerpo', 50)}`;
    const chunks = chunkNote('Nota', long, 4000);
    expect(chunks[0].heading).toBeNull();
    expect(chunks.at(-1)!.heading!.length).toBe(MAX_HEADING_CHARS);
    expect(chunkEmbeddingInput('Nota', { heading: 'A › B', text: 'x' })).toBe('Nota: Nota\nSección: A › B\n\nx');
    // Same text, same hash; one word changed, another hash
    expect(chunkNote('Nota', long, 4000).map(c => c.hash)).toEqual(chunks.map(c => c.hash));
    expect(chunkNote('Nota', long.replace('cuerpo', 'cambio'), 4000).at(-1)!.hash).not.toBe(chunks.at(-1)!.hash);
  });
});

describe('chunked notes in snapshots, retrieval, the prompt and the Consultor', () => {
  let container: StartedPostgreSqlContainer;
  let db: any;
  let schema: any;
  let fake: FakeAi;
  let vault: string;
  let projectDir: string;
  let contentId: string;
  const article = 'volcan erupcion lava magma ceniza crater';

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

    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-chunks-'));
    projectDir = path.join(vault, 'Projects', 'Novela');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'borrador.md'), draft());
    await fs.writeFile(path.join(projectDir, 'ideas.md'), '# Ideas\n\nOtra cosa breve sobre faros.');
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault);

    const [content] = await db.insert(schema.contents).values({
      uri: 'https://example.com/volcanes', title: 'Volcanes', summary: article, ingestStatus: 'ready',
      embedding: fakeEmbedding(article), embeddingModel: 'bge-m3',
    }).returning();
    contentId = content.id;
  }, 120000);

  afterAll(async () => {
    fake?.uninstall();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const latestSnapshot = async () => {
    const { desc } = await import('drizzle-orm');
    return (await db.select().from(schema.projectSnapshots).orderBy(desc(schema.projectSnapshots.capturedAt)).limit(1))[0];
  };

  it('stores pieces for the long note only', async () => {
    const { eq } = await import('drizzle-orm');
    const snapshot = await latestSnapshot();
    const chunks = await db.select().from(schema.projectNoteChunks).where(eq(schema.projectNoteChunks.projectSnapshotId, snapshot.id));
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
    const draftNote = notes.find((n: any) => n.notePath === 'borrador.md');
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c: any) => c.noteSnapshotId === draftNote.id && c.embeddingModel === 'bge-m3')).toBe(true);
    expect(chunks.find((c: any) => c.heading === 'Borrador › Acto 3').content).toBe(ACT3);
  });

  it('finds the project through a section past the first 4,000 characters, and names it', async () => {
    const { retrieveCandidates } = await import('../src/evaluator/retrieval');
    const [candidate] = await retrieveCandidates(fakeEmbedding(article));
    expect(candidate).toMatchObject({ notePath: 'borrador.md', noteSection: 'Borrador › Acto 3', level: 'note' });
    expect(candidate.distance).toBeLessThan(0.3);

    // Pieces of another embedding model are never compared (I7)
    await db.update(schema.projectNoteChunks).set({ embeddingModel: 'otro-modelo' });
    expect(await retrieveCandidates(fakeEmbedding(article))).toEqual([]);
    await db.update(schema.projectNoteChunks).set({ embeddingModel: 'bge-m3' });
  });

  it('a backlog run picks up an article that only a section matches, and the hint names the section', async () => {
    const { findBacklogUnevaluatedContents, evaluateContentMatch } = await import('../src/evaluator');
    const [project] = await db.select().from(schema.projects);
    expect(await findBacklogUnevaluatedContents(project.id)).toEqual([contentId]);

    await evaluateContentMatch(contentId);
    const triage = fake.calls.filter(c => c.kind === 'triage').at(-1)!;
    expect(triage.user).toContain('NOTA MÁS CERCANA AL ARTÍCULO (orientativa, no obligatoria): borrador.md ("Borrador"), sección «Borrador › Acto 3»');
  });

  it('the Consultor sends the closest section of a long note, and says which', async () => {
    const Fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const server = Fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.register((await import('../src/api/routes/library')).default);
    fake.answerNext({ diagnosis: 'Según [N1].', projectViability: null, matchedContents: [], matchedNotes: [{ refId: 'N1', whyItConnects: 'El acto 3.' }] });
    const res = await server.inject({ method: 'POST', url: '/api/library/consult', payload: { query: article } });
    await server.close();
    expect(res.statusCode).toBe(200);
    const prompt = fake.calls.at(-1)!.user;
    expect(prompt).toContain('[N1] Proyecto: "Novela" | Archivo de Nota: "borrador.md" | Sección: "Borrador › Acto 3"');
    expect(prompt).toContain(ACT3);
    expect(res.json().matchedNotes[0]).toMatchObject({ notePath: 'borrador.md', section: 'Borrador › Acto 3', contentSnippet: ACT3 });
  });

  it('re-embeds only the pieces an edit changed', async () => {
    const { eq } = await import('drizzle-orm');
    const before = fake.embeddings.length;
    await fs.writeFile(path.join(projectDir, 'borrador.md'), draft(ACT1.replace('linterna', 'lampara')));
    const { reconcileProject } = await import('../src/vault/reconciler');
    await reconcileProject(projectDir, vault);
    const pieceInputs = fake.embeddings.slice(before).filter(t => t.includes('\nSección:'));
    const snapshot = await latestSnapshot();
    const chunks = await db.select().from(schema.projectNoteChunks).where(eq(schema.projectNoteChunks.projectSnapshotId, snapshot.id));
    expect(pieceInputs.length).toBeGreaterThanOrEqual(1);
    expect(pieceInputs.length).toBeLessThan(chunks.length);
    expect(pieceInputs.every(t => t.includes('Acto 1'))).toBe(true);
  }, 30000);
});
