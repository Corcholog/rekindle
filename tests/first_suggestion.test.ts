import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { installFakeAi, FakeAi } from './helpers/fakeAi';

// The path a new user follows from the README, offline: the demo vault is indexed, a clipped
// article is ingested and evaluated, a pending suggestion appears, and accepting it writes one
// callout into the matching project's suggestions.md. A control article that matches nothing
// produces no suggestion. Models are replaced by deterministic fakes; the page is stubbed.

const FARO_HTML = `<html><head><title>Faro</title></head><body><article><p>Un faro es una torre en la costa con una luz potente para guiar a los barcos durante la noche y la niebla. La lente de Fresnel concentra la luz del faro y el farero mantiene la luz encendida durante los temporales.</p></article></body></html>`;
const PLANTAS_HTML = `<html><head><title>Fotosíntesis</title></head><body><article><p>La clorofila de las hojas absorbe energía solar y transforma dióxido de carbono y agua en glucosa y oxígeno dentro del cloroplasto.</p></article></body></html>`;

// One scripted responder for every call: leftover queue entries are harmless to later tests
const respond = (call: { kind: string; user: string }) => {
  if (call.kind === 'summary') {
    return call.user.includes('farero')
      ? { summary: 'Un faro es una torre en la costa con una luz para guiar a los barcos en la noche y la niebla; el farero mantiene la luz encendida durante los temporales.' }
      : { summary: 'La fotosíntesis convierte la energía solar en glucosa y oxígeno gracias a la clorofila de las hojas.' };
  }
  return call.user.includes('El faro del fin del mundo')
    ? {
      verdict: 'actionable', confidenceScore: 0.9, triageReasoning: 'Aporta detalles reales sobre el oficio del farero.',
      action: {
        actionType: 'evidence_citation', observation: 'El artículo describe la luz y el trabajo del farero.',
        suggestedAction: 'Citar la descripción de la luz del faro en las notas de investigación.', targetFile: 'investigacion_faros.md',
      },
    }
    : { verdict: 'irrelevant', confidenceScore: 0.2, triageReasoning: 'Sin relación.', action: null };
};

describe('From a clean install to a first accepted suggestion', () => {
  let container: StartedPostgreSqlContainer;
  let vault: string;
  let server: any;
  let boss: any;
  let db: any;
  let schema: any;
  let fake: FakeAi;

  const waitFor = async <T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> => {
    for (let i = 0; i < 120; i++) {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-first-'));
    await fs.cp('demo_vault', vault, { recursive: true });
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());
    vi.stubEnv('EMBED_MODEL', 'bge-m3');
    vi.stubEnv('VAULT_PATH', vault);

    const dbModule = await import('../src/db/index');
    db = dbModule.db;
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await dbModule.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(db, { migrationsFolder: './drizzle' });
    schema = await import('../src/db/schema');
    const { sharedAiProvider } = await import('../src/ai/aiProvider');
    fake = installFakeAi(sharedAiProvider);

    const queue = await import('../src/queue/index');
    boss = queue.boss;
    await queue.startQueue();
    await (await import('../src/workers/ingestionWorker')).setupIngestionWorker();
    await (await import('../src/workers/evaluationWorker')).setupEvaluationWorker();
    server = (await import('../src/api/server')).server;
    await server.ready();

    await (await import('../src/vault/reconciler')).reconcileAllProjects(vault, true);

    global.fetch = vi.fn(async (url: any) => ({
      ok: true,
      text: async () => (String(url).includes('Faro') ? FARO_HTML : PLANTAS_HTML),
    })) as any;
  }, 300000);

  afterAll(async () => {
    await server?.close();
    if (boss) await boss.stop();
    const { pool } = await import('../src/db/index');
    await pool.end();
    await container?.stop();
    await fs.rm(vault, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const ingest = async (url: string) => {
    const res = await server.inject({ method: 'POST', url: '/api/ingest', payload: { url } });
    expect(res.statusCode).toBe(202);
    return res.json().contentId as string;
  };
  const ready = async (contentId: string) => {
    const { eq } = await import('drizzle-orm');
    return waitFor(async () => {
      const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
      if (row?.ingestStatus === 'failed') throw new Error(`ingest failed: ${row.ingestStatusReason}`);
      return row?.ingestStatus === 'ready' ? row : false;
    }, 'the article to be ready');
  };

  it('indexes every demo project with its notes', async () => {
    const { eq } = await import('drizzle-orm');
    const projects = await db.select().from(schema.projects);
    expect(projects.map((p: any) => p.folderPath).sort()).toEqual([
      'Projects/Atencion_y_Redes', 'Projects/El_Faro_del_Fin_del_Mundo',
      'Projects/Juego_de_Mesa_Mareas', 'Projects/Podcast_Ciudades_Invisibles',
    ]);
    const faro = projects.find((p: any) => p.folderPath.endsWith('El_Faro_del_Fin_del_Mundo'));
    const [snapshot] = await db.select().from(schema.projectSnapshots).where(eq(schema.projectSnapshots.projectId, faro.id));
    const notes = await db.select().from(schema.projectNoteSnapshots).where(eq(schema.projectNoteSnapshots.projectSnapshotId, snapshot.id));
    expect(notes.map((n: any) => n.notePath).sort()).toContain('personajes/el_farero.md');
    expect(notes).toHaveLength(5);
  });

  it('turns a matching article into a pending suggestion; accepting it writes one callout', { timeout: 120000 }, async () => {
    fake.answerNext(...Array(6).fill(respond));
    const contentId = await ingest('https://es.wikipedia.org/wiki/Faro');
    await ready(contentId);

    const { eq } = await import('drizzle-orm');
    const suggestion = await waitFor(async () => {
      const [row] = await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId));
      return row;
    }, 'the first suggestion');
    expect(suggestion.status).toBe('pending');
    expect(suggestion.targetFile).toBe('investigacion_faros.md');

    // I1: nothing in the vault changes until the owner accepts
    const suggestionsFile = path.join(vault, 'Projects', 'El_Faro_del_Fin_del_Mundo', 'suggestions.md');
    await expect(fs.access(suggestionsFile)).rejects.toThrow();

    const accepted = await server.inject({ method: 'PATCH', url: `/api/suggestions/${suggestion.id}`, payload: { status: 'accepted' } });
    expect(accepted.statusCode).toBe(200);

    const written = await fs.readFile(suggestionsFile, 'utf-8');
    expect(written.match(/> \[!/g)).toHaveLength(1);
    expect(written).toContain('Citar la descripción de la luz del faro');
    for (const other of ['Atencion_y_Redes', 'Juego_de_Mesa_Mareas', 'Podcast_Ciudades_Invisibles']) {
      await expect(fs.access(path.join(vault, 'Projects', other, 'suggestions.md'))).rejects.toThrow();
    }
  });

  it('creates no suggestion for an article that matches no project', { timeout: 120000 }, async () => {
    fake.answerNext(...Array(6).fill(respond));
    const contentId = await ingest('https://es.wikipedia.org/wiki/Fotos%C3%ADntesis');
    await ready(contentId);
    const { eq } = await import('drizzle-orm');
    // Give the evaluation job time to run, then check nothing was produced
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(await db.select().from(schema.actionSuggestions).where(eq(schema.actionSuggestions.contentId, contentId))).toHaveLength(0);
    expect(await db.select().from(schema.evaluations).where(eq(schema.evaluations.contentId, contentId))).toHaveLength(0);
  });
});
