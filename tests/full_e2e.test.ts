import 'dotenv/config';
import { describe, it, beforeAll, afterAll, vi, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Real-LLM test: requires GEMINI_API_KEY in the environment (.env) and a local Ollama with bge-m3.
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!hasGeminiKey)('Full E2E Flow (real LLM)', () => {
  let container: any;
  let vaultPath: string;
  let server: any;

  beforeAll(async () => {
    // 1. Setup Test DB
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('loomdb_e2e')
      .withUsername('tester')
      .withPassword('testpass')
      .start();
    vi.stubEnv('DATABASE_URL', container.getConnectionUri());

    // 2. Create Dummy Vault in a unique temp dir (avoids leftovers between runs)
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-e2e-vault-'));
    await fs.mkdir(path.join(vaultPath, 'Projects', 'AI_Agents'), { recursive: true });

    const projectMd = `---
tags:
  - project
---
# Proyecto: AI Agents
Este proyecto busca construir un ecosistema de agentes autónomos que se comuniquen mediante eventos (Pub/Sub) para resolver tareas complejas de programación.
`;
    await fs.writeFile(path.join(vaultPath, 'Projects', 'AI_Agents', 'ideas.md'), projectMd);
    vi.stubEnv('VAULT_PATH', vaultPath);

    // 3. Init DB schema
    const { pool, db: drizzleDb } = await import('../src/db/index');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await migrate(drizzleDb, { migrationsFolder: './drizzle' });

    // 4. Mock fetch ONLY for the ingestion URL (real fetch is preserved for the Gemini API)
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: any, ...args: any[]) => {
      const urlStr = typeof url === 'string' ? url : url?.toString() || '';
      if (urlStr.includes('techblog.com')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => `<html><title>El poder de Pub/Sub en Sistemas Distribuidos</title><body>
            <p>Un artículo técnico donde exploramos cómo los patrones Pub/Sub permiten que múltiples microservicios o agentes operen de forma asíncrona y escalable sin acoplamiento fuerte. El uso del broker de mensajes es vital para la inteligencia artificial distribuida.</p>
          </body></html>`
        };
      }
      return originalFetch(url, ...args);
    });

    // 5. Start Queues & Workers
    const { startQueue } = await import('../src/queue');
    await startQueue();
    const { setupIngestionWorker } = await import('../src/workers/ingestionWorker');
    await setupIngestionWorker();
    const { setupEvaluationWorker } = await import('../src/workers/evaluationWorker');
    await setupEvaluationWorker();
    const { setupVaultWorker } = await import('../src/workers/vaultWorker');
    await setupVaultWorker();

    // 6. API server (in-process, via inject)
    server = (await import('../src/api/server')).server;
    await server.ready();
  }, 120000);

  afterAll(async () => {
    const { boss } = await import('../src/queue');
    if (boss) await boss.stop();
    const { pool } = await import('../src/db/index');
    await pool.end();
    if (container) await container.stop();
    await fs.rm(vaultPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('Vault -> Ingest -> Evaluate -> Suggest (pending) -> Accept -> Writeback', async () => {
    const { db } = await import('../src/db');
    const { projectSnapshots, contents, evaluations, actionSuggestions } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const suggestionsMdPath = path.join(vaultPath, 'Projects', 'AI_Agents', 'suggestions.md');

    // STEP 1: Reconcile vault (Phase 4)
    console.log('\n[Fase 4] Escaneando Vault...');
    const { bootReconcile } = await import('../src/vault/reconciler');
    await bootReconcile(vaultPath);
    const snapshots = await db.select().from(projectSnapshots);
    expect(snapshots).toHaveLength(1);
    console.log('📌 Tesis detectada:', snapshots[0].thesisText);

    // STEP 2: Ingest (Phase 3)
    console.log('\n[Fase 3] Inyectando URL a procesar...');
    const { boss } = await import('../src/queue');
    const url = 'https://techblog.com/pub-sub-ai';
    const [inserted] = await db.insert(contents)
      .values({ uri: url, ingestStatus: 'pending' })
      .returning({ id: contents.id });
    await boss.send('ingest_url', { contentId: inserted.id, url });

    // STEP 3: Wait for a pending suggestion (Phase 5)
    console.log('\n⏳ Esperando: Scraping -> Resumen (Gemini) -> Vector (bge-m3) -> Triage (Gemini) -> Acción (Gemini)...');
    let suggestion: any;
    for (let i = 0; i < 300 && !suggestion; i++) {
      await new Promise(r => setTimeout(r, 1000));
      [suggestion] = await db.select().from(actionSuggestions).where(eq(actionSuggestions.contentId, inserted.id));
    }
    if (!suggestion) throw new Error('Timeout esperando la sugerencia');

    // Nothing must reach Obsidian before the user reviews it
    expect(suggestion.status).toBe('pending');
    expect(suggestion.writtenToVault).toBe(false);
    await expect(fs.access(suggestionsMdPath)).rejects.toThrow();

    // STEP 4: Accept through the API (Phase 6)
    console.log('\n[Fase 6] Aceptando sugerencia vía API...');
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/suggestions/${suggestion.id}`,
      payload: { status: 'accepted', userFeedback: 'Aceptada en prueba E2E.' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).writtenToVault).toBe(true);

    const suggestionsContent = await fs.readFile(suggestionsMdPath, 'utf-8');
    expect(suggestionsContent).toContain('> [!tip] Sugerencia Aceptada');
    expect(suggestionsContent.match(/\[!tip\]/g)).toHaveLength(1);

    console.log('\n===== RESULTADO FINAL EN OBSIDIAN (suggestions.md) =====');
    console.log(suggestionsContent);

    // Metadata
    const [dbContent] = await db.select().from(contents).where(eq(contents.id, inserted.id));
    const [dbEval] = await db.select().from(evaluations).where(eq(evaluations.contentId, inserted.id));
    console.log('\n📊 METADATA');
    console.log('- Resumen (Gemini):', dbContent?.summary);
    console.log('- Embedding (Ollama bge-m3):', dbContent?.embedding?.length, 'dimensiones');
    console.log('- Veredicto:', dbEval?.verdict, '| Confianza:', dbEval?.confidenceScore);
    console.log('- Razonamiento:', dbEval?.triageReasoning);
    console.log('- Acción:', suggestion.actionType, '->', suggestion.suggestedAction);
  }, 360000);
});
