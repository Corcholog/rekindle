import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '../../db';
import { projects, projectSnapshots, actionSuggestions, evaluations, contents } from '../../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { getCurrentVaultPath } from '../../vault/config';
import { reconcileProject } from '../../vault/reconciler';
import { sharedAiProvider } from '../../ai/OllamaProvider';

const ProjectItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  folderPath: z.string(),
  isActive: z.boolean(),
  thesisText: z.string().nullable().optional(),
  noteTitles: z.array(z.string()).optional(),
  counts: z.object({
    pending: z.number(),
    accepted: z.number(),
    discarded: z.number(),
    tentative: z.number().optional(),
    active: z.number().optional(),
    total: z.number(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProjectDetailSchema = ProjectItemSchema.extend({
  snapshotsCount: z.number(),
  latestSnapshotAt: z.string().nullable().optional(),
});

const ListProjectsQuerySchema = z.object({
  isActive: z.enum(['true', 'false'])
    .transform(v => v === 'true')
    .optional(),
});

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function (server: FastifyInstance) {
  // 1. List Projects with latest snapshot and suggestion counts
  server.get('/api/projects', {
    schema: {
      querystring: ListProjectsQuerySchema,
      response: {
        200: z.object({
          projects: z.array(ProjectItemSchema),
        }),
      },
    },
  }, async (request, reply) => {
    const { isActive } = request.query as z.infer<typeof ListProjectsQuerySchema>;

    const whereClause = isActive !== undefined ? eq(projects.isActive, isActive) : undefined;
    const projectList = await db.select().from(projects).where(whereClause).orderBy(projects.title);

    if (projectList.length === 0) {
      return reply.send({ projects: [] });
    }

    const projectIds = projectList.map(p => p.id);

    // 1. Fetch latest snapshot per project without fetching embeddings or note content
    const snapshotRows = await db.execute<{
      project_id: string;
      thesis_text: string | null;
      note_titles: any;
      captured_at: string | null;
    }>(sql`
      SELECT DISTINCT ON (project_id)
        project_id,
        thesis_text,
        note_titles,
        captured_at
      FROM project_snapshots
      WHERE project_id IN ${sql`(${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})`}
      ORDER BY project_id, captured_at DESC
    `);

    const snapshotMap = new Map<string, { thesisText: string | null; noteTitles: string[] }>();
    for (const r of snapshotRows.rows) {
      snapshotMap.set(r.project_id, {
        thesisText: r.thesis_text ?? null,
        noteTitles: Array.isArray(r.note_titles) ? r.note_titles : [],
      });
    }

    // 2. Count suggestions by status
    const countRows = await db.select({
      projectId: actionSuggestions.projectId,
      status: actionSuggestions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(actionSuggestions)
    .where(inArray(actionSuggestions.projectId, projectIds))
    .groupBy(actionSuggestions.projectId, actionSuggestions.status);

    const sugCounts = new Map<string, number>();
    for (const c of countRows) {
      sugCounts.set(`${c.projectId}:${c.status}`, c.count);
    }

    // 3. Count evaluations (tentative and irrelevant)
    const evalRows = await db.select({
      projectId: projectSnapshots.projectId,
      verdict: evaluations.verdict,
      count: sql<number>`count(*)::int`,
    })
    .from(evaluations)
    .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
    .where(and(
      inArray(projectSnapshots.projectId, projectIds),
      inArray(evaluations.verdict, ['tentative', 'irrelevant']),
      sql`(evaluations.verdict = 'irrelevant' OR NOT EXISTS (SELECT 1 FROM action_suggestions s WHERE s.evaluation_id = ${evaluations.id}))`
    ))
    .groupBy(projectSnapshots.projectId, evaluations.verdict);

    const evalCounts = new Map<string, number>();
    for (const e of evalRows) {
      if (e.verdict) {
        evalCounts.set(`${e.projectId}:${e.verdict}`, e.count);
      }
    }

    const results = projectList.map(proj => {
      const snap = snapshotMap.get(proj.id);
      const pending = sugCounts.get(`${proj.id}:pending`) ?? 0;
      const accepted = sugCounts.get(`${proj.id}:accepted`) ?? 0;
      const discardedSug = sugCounts.get(`${proj.id}:discarded`) ?? 0;
      const tentative = evalCounts.get(`${proj.id}:tentative`) ?? 0;
      const irrelevant = evalCounts.get(`${proj.id}:irrelevant`) ?? 0;

      const totalDiscarded = discardedSug + irrelevant;
      const active = pending + tentative;

      return {
        id: proj.id,
        title: proj.title,
        folderPath: proj.folderPath,
        isActive: proj.isActive,
        thesisText: snap?.thesisText ?? null,
        noteTitles: snap?.noteTitles ?? [],
        counts: {
          pending,
          accepted,
          discarded: totalDiscarded,
          tentative,
          active,
          total: active + accepted + totalDiscarded,
        },
        createdAt: proj.createdAt.toISOString(),
        updatedAt: proj.updatedAt.toISOString(),
      };
    });

    return reply.send({ projects: results });
  });

  // 2. Get Single Project Detail
  server.get('/api/projects/:id', {
    schema: {
      params: IdParamSchema,
      response: {
        200: ProjectDetailSchema,
        404: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;

    const [proj] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!proj) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Project with id ${id} not found`,
      });
    }

    // Get latest snapshot without embeddings or raw note content
    const [latestSnapshot] = await db.select({
      id: projectSnapshots.id,
      thesisText: projectSnapshots.thesisText,
      noteTitles: projectSnapshots.noteTitles,
      capturedAt: projectSnapshots.capturedAt,
    })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, proj.id))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

    const [snapCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, proj.id));

    // Count suggestions by status
    const countRows = await db.select({
      status: actionSuggestions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(actionSuggestions)
    .where(eq(actionSuggestions.projectId, proj.id))
    .groupBy(actionSuggestions.status);

    let pending = 0;
    let accepted = 0;
    let discardedSug = 0;
    for (const c of countRows) {
      if (c.status === 'pending') pending = c.count;
      if (c.status === 'accepted') accepted = c.count;
      if (c.status === 'discarded') discardedSug = c.count;
    }

    const [tentativeRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .where(and(
        eq(projectSnapshots.projectId, proj.id),
        eq(evaluations.verdict, 'tentative'),
        sql`NOT EXISTS (SELECT 1 FROM action_suggestions s WHERE s.evaluation_id = ${evaluations.id})`
      ));
    const tentative = tentativeRow?.count ?? 0;

    const [irrelevantRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .where(and(
        eq(projectSnapshots.projectId, proj.id),
        eq(evaluations.verdict, 'irrelevant')
      ));
    const irrelevant = irrelevantRow?.count ?? 0;
    const totalDiscarded = discardedSug + irrelevant;
    const active = pending + tentative;

    return reply.send({
      id: proj.id,
      title: proj.title,
      folderPath: proj.folderPath,
      isActive: proj.isActive,
      thesisText: latestSnapshot?.thesisText ?? null,
      noteTitles: (latestSnapshot?.noteTitles as string[]) ?? [],
      counts: {
        pending,
        accepted,
        discarded: totalDiscarded,
        tentative,
        active,
        total: active + accepted + totalDiscarded,
      },
      snapshotsCount: snapCount?.count ?? 0,
      latestSnapshotAt: latestSnapshot?.capturedAt ? latestSnapshot.capturedAt.toISOString() : null,
      createdAt: proj.createdAt.toISOString(),
      updatedAt: proj.updatedAt.toISOString(),
    });
  });

  const synthesisSchema = z.object({
    title: z.string().describe('Título claro y representativo para el brief de investigación del proyecto'),
    executiveSummary: z.string().describe('Resumen ejecutivo de 1 o 2 párrafos que unifica las contribuciones aceptadas'),
    markdownContent: z.string().describe('Cuerpo en formato markdown con encabezados de sección, síntesis de evidencias, contraargumentos superados y conexiones entre borradores'),
    suggestedNextSteps: z.array(z.string()).describe('Lista de 3 a 5 tareas accionables recomendadas para continuar la redacción del proyecto'),
  });

  const SynthesizeResponseSchema = z.object({
    success: z.boolean(),
    filePath: z.string(),
    title: z.string(),
    executiveSummary: z.string(),
    suggestedNextSteps: z.array(z.string()),
    acceptedCount: z.number(),
    writtenToVault: z.boolean(),
  });

  // 3. POST /api/projects/:id/synthesize: Synthesize Project Backlog into Research Brief
  server.post('/api/projects/:id/synthesize', {
    schema: {
      params: IdParamSchema,
      response: {
        200: SynthesizeResponseSchema,
        400: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
        404: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
        500: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [proj] = await db.select().from(projects).where(eq(projects.id, id));
    if (!proj) {
      return reply.status(404).send({ error: 'Not Found', message: 'Proyecto no encontrado' });
    }

    // 1. Fetch all accepted suggestions
    const acceptedList = await db.select({
      id: actionSuggestions.id,
      actionType: actionSuggestions.actionType,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      targetFile: actionSuggestions.targetFile,
      userFeedback: actionSuggestions.userFeedback,
      sourceTitle: contents.title,
      sourceUri: contents.uri,
    })
    .from(actionSuggestions)
    .leftJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .where(and(
      eq(actionSuggestions.projectId, id),
      eq(actionSuggestions.status, 'accepted')
    ));

    if (acceptedList.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No hay sugerencias aceptadas para sintetizar en este proyecto. Acepta al menos una sugerencia en el panel.',
      });
    }

    // 2. Fetch latest project snapshot context
    const [latestSnapshot] = await db.select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, id))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

    const projectContext = latestSnapshot?.notesContent || latestSnapshot?.thesisText || proj.title;

    // 3. Format accepted suggestions list for LLM
    const suggestionsPrompt = acceptedList.map((s, idx) => {
      return `[Sugerencia ${idx + 1} - ${s.actionType.toUpperCase()}]
- Nota destino: ${s.targetFile || 'general'}
- Acción propuesta: ${s.suggestedAction}
- Observación/Aporte: ${s.observation}
- Fuente: "${s.sourceTitle || 'Fuente web'}" (${s.sourceUri || 'N/A'})${s.userFeedback ? `\n- Feedback del usuario: ${s.userFeedback}` : ''}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `Eres un editor jefe y sintetizador de investigación para Obsidian.
Tu objetivo es compilar y unificar todas las sugerencias aceptadas en un informe de investigación estructurado y coherente (Research Brief).
REGLAS:
1. Responde SIEMPRE en ESPAÑOL.
2. Integra los aportes, citas de evidencia y contraargumentos en una narrativa de investigación lógica.
3. Utiliza formato Markdown con títulos claros, listas y wikilinks de Obsidian como [[${proj.title}]] o [[notas_relevantes]].
4. Sé exhaustivo pero conciso, facilitando al autor la redacción de sus borradores.`;

    const userMessage = `<CONTEXTO_DEL_PROYECTO>
Proyecto: "${proj.title}"
Notas y Borradores Actuales:
${projectContext.substring(0, 10000)}
</CONTEXTO_DEL_PROYECTO>

<SUGERENCIAS_ACEPTADAS_A_SINTETIZAR>
Total de sugerencias aceptadas: ${acceptedList.length}

${suggestionsPrompt}
</SUGERENCIAS_ACEPTADAS_A_SINTETIZAR>`;

    let result;
    try {
      const evalResult = await sharedAiProvider.evaluateContent(systemPrompt, userMessage, synthesisSchema);
      result = evalResult.data;
    } catch (err: any) {
      server.log.error({ err }, 'Error generating project synthesis via LLM');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Error al generar la síntesis del proyecto con el modelo de lenguaje.',
      });
    }

    // 4. Write synthesized document to Obsidian Vault
    const vaultPath = getCurrentVaultPath();
    let writtenToVault = false;
    const fileName = 'research_brief.md';

    if (vaultPath) {
      try {
        const projectFolderPath = path.join(vaultPath, proj.folderPath);
        const targetFilePath = path.join(projectFolderPath, fileName);

        const frontmatter = `---
title: "${result.title.replace(/"/g, '\\"')}"
type: research_brief
synthesized_at: "${new Date().toISOString()}"
accepted_suggestions_count: ${acceptedList.length}
tags:
  - loom/synthesis
  - loom/research-brief
---

# ${result.title}

> [!abstract] Resumen Ejecutivo
> ${result.executiveSummary.replace(/\n/g, '\n> ')}

${result.markdownContent}

## Próximos Pasos Recomendados
${(result.suggestedNextSteps || []).map(step => `- [ ] ${step}`).join('\n')}

---
*Generado automáticamente por Loom compilando ${acceptedList.length} sugerencias aceptadas.*
`;

        await fs.mkdir(projectFolderPath, { recursive: true });
        await fs.writeFile(targetFilePath, frontmatter, 'utf-8');
        writtenToVault = true;

        // Reconcile project so newly written brief is immediately parsed into snapshots
        await reconcileProject(projectFolderPath, vaultPath, true);
        console.log(`[Synthesizer] Research brief generated and saved at: ${targetFilePath}`);
      } catch (err) {
        console.error('[Synthesizer] Failed writing research brief to vault:', err);
      }
    }

    return reply.send({
      success: true,
      filePath: fileName,
      title: result.title,
      executiveSummary: result.executiveSummary,
      suggestedNextSteps: result.suggestedNextSteps || [],
      acceptedCount: acceptedList.length,
      writtenToVault,
    });
  });
}
