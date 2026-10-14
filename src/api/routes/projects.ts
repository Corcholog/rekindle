import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '../../db';
import { projects, projectSnapshots, projectNoteSnapshots, actionSuggestions, evaluations, contents } from '../../db/schema';
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

// Feature 5: Cross-Project Synergy Schemas
const SynergyNoteSchema = z.object({
  noteATitle: z.string(),
  noteAPath: z.string(),
  noteBSTitle: z.string(),
  noteBPath: z.string(),
  distance: z.number(),
  similarityScore: z.number(),
});

const ProjectSynergySchema = z.object({
  id: z.string(),
  projectA: z.object({
    id: z.string().uuid(),
    title: z.string(),
    folderPath: z.string(),
    thesisText: z.string().nullable().optional(),
  }),
  projectB: z.object({
    id: z.string().uuid(),
    title: z.string(),
    folderPath: z.string(),
    thesisText: z.string().nullable().optional(),
  }),
  similarityScore: z.number(),
  projectDistance: z.number().nullable().optional(),
  bestNoteDistance: z.number().nullable().optional(),
  rationale: z.string(),
  closestNotes: z.array(SynergyNoteSchema),
});

function computeCosineDistance(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1.0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, 1 - sim);
}

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

  // 1.5 Get Cross-Project Synergies (Feature 5)
  server.get('/api/projects/synergies', {
    schema: {
      querystring: z.object({
        minSimilarity: z.coerce.number().min(0).max(100).optional().default(20),
        limit: z.coerce.number().min(1).max(50).optional().default(15),
      }),
      response: {
        200: z.object({
          synergies: z.array(ProjectSynergySchema),
          totalCount: z.number(),
          message: z.string().optional(),
        }),
      },
    },
  }, async (request, reply) => {
    const { minSimilarity = 20, limit = 15 } = request.query as any;

    const activeProjects = await db.select({
      id: projects.id,
      title: projects.title,
      folderPath: projects.folderPath,
    })
    .from(projects)
    .where(eq(projects.isActive, true));

    if (activeProjects.length < 2) {
      return reply.send({
        synergies: [],
        totalCount: 0,
        message: 'Se requieren al menos dos proyectos activos con notas indexadas para calcular sinergias.',
      });
    }

    // Get latest snapshots per project with embeddings
    const projectIds = activeProjects.map(p => p.id);
    const snaps = await db.select({
      id: projectSnapshots.id,
      projectId: projectSnapshots.projectId,
      thesisText: projectSnapshots.thesisText,
      embedding: projectSnapshots.embedding,
    })
    .from(projectSnapshots)
    .where(inArray(projectSnapshots.projectId, projectIds))
    .orderBy(desc(projectSnapshots.capturedAt));

    const snapMap = new Map<string, typeof snaps[0]>();
    for (const s of snaps) {
      if (!snapMap.has(s.projectId)) {
        snapMap.set(s.projectId, s);
      }
    }

    const synergies = [];

    // Compare all pairs of active projects
    for (let i = 0; i < activeProjects.length; i++) {
      for (let j = i + 1; j < activeProjects.length; j++) {
        const pA = activeProjects[i];
        const pB = activeProjects[j];

        const snapA = snapMap.get(pA.id);
        const snapB = snapMap.get(pB.id);

        const projectDist = computeCosineDistance(snapA?.embedding, snapB?.embedding);

        // Fetch closest notes between pA and pB via HNSW cosine distance
        const noteResult = await db.execute<{
          noteATitle: string;
          noteAPath: string;
          noteBTitle: string;
          noteBPath: string;
          distance: number;
        }>(sql`
          SELECT 
            na.note_title as "noteATitle",
            na.note_path as "noteAPath",
            nb.note_title as "noteBTitle",
            nb.note_path as "noteBPath",
            (na.embedding <=> nb.embedding)::float as distance
          FROM project_note_snapshots na
          INNER JOIN project_note_snapshots nb ON na.project_id = ${pA.id}::uuid AND nb.project_id = ${pB.id}::uuid
          WHERE na.embedding IS NOT NULL AND nb.embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT 3
        `);
        const noteMatches = noteResult.rows || [];

        const closestNotes = noteMatches.map(nm => {
          const dist = typeof nm.distance === 'number' ? nm.distance : parseFloat(nm.distance as any);
          return {
            noteATitle: nm.noteATitle,
            noteAPath: nm.noteAPath,
            noteBSTitle: nm.noteBTitle,
            noteBPath: nm.noteBPath,
            distance: Math.round(dist * 1000) / 1000,
            similarityScore: Math.max(0, Math.min(100, Math.round((1 - dist) * 100))),
          };
        });

        let bestDist: number | null = projectDist;
        if (closestNotes.length > 0) {
          if (bestDist === null || closestNotes[0].distance < bestDist) {
            bestDist = closestNotes[0].distance;
          }
        }

        if (bestDist === null) continue;

        const similarityScore = Math.max(0, Math.min(100, Math.round((1 - bestDist) * 100)));
        if (similarityScore < minSimilarity) continue;

        let rationale = '';
        if (closestNotes.length > 0) {
          rationale = `Afinidad conceptual detectada entre [[${closestNotes[0].noteATitle}]] (${pA.title}) y [[${closestNotes[0].noteBSTitle}]] (${pB.title}).`;
        } else {
          rationale = `Resonancia temática detectada entre ${pA.title} y ${pB.title}.`;
        }

        synergies.push({
          id: `${pA.id}_${pB.id}`,
          projectA: {
            id: pA.id,
            title: pA.title,
            folderPath: pA.folderPath,
            thesisText: snapA?.thesisText ?? null,
          },
          projectB: {
            id: pB.id,
            title: pB.title,
            folderPath: pB.folderPath,
            thesisText: snapB?.thesisText ?? null,
          },
          similarityScore,
          projectDistance: projectDist !== null ? Math.round(projectDist * 1000) / 1000 : null,
          bestNoteDistance: closestNotes.length > 0 ? closestNotes[0].distance : null,
          rationale,
          closestNotes,
        });
      }
    }

    synergies.sort((a, b) => b.similarityScore - a.similarityScore);
    const sliced = synergies.slice(0, limit);

    return reply.send({
      synergies: sliced,
      totalCount: synergies.length,
    });
  });

  // 1.6 Explore and Synthesize Cross-Project Synergy (Feature 5)
  server.post('/api/projects/synergies/explore', {
    schema: {
      body: z.object({
        projectAId: z.string().uuid(),
        projectBId: z.string().uuid(),
        saveToVault: z.boolean().optional().default(true),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          bridgeTitle: z.string(),
          overview: z.string(),
          sharedProblems: z.array(z.string()),
          mutualBenefits: z.array(z.string()),
          markdownContent: z.string(),
          filePath: z.string().nullable().optional(),
          writtenToVault: z.boolean(),
        }),
        404: z.object({ error: z.string(), message: z.string() }),
        500: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { projectAId, projectBId, saveToVault = true } = request.body as any;

    const [projA] = await db.select().from(projects).where(eq(projects.id, projectAId)).limit(1);
    const [projB] = await db.select().from(projects).where(eq(projects.id, projectBId)).limit(1);

    if (!projA || !projB) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Uno o ambos proyectos no fueron encontrados.',
      });
    }

    const [snapA] = await db.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, projA.id)).orderBy(desc(projectSnapshots.capturedAt)).limit(1);
    const [snapB] = await db.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, projB.id)).orderBy(desc(projectSnapshots.capturedAt)).limit(1);

    const notesA = await db.select().from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectId, projA.id)).limit(10);
    const notesB = await db.select().from(projectNoteSnapshots).where(eq(projectNoteSnapshots.projectId, projB.id)).limit(10);

    const synergySynthesisSchema = z.object({
      bridgeTitle: z.string().describe('Título sugerido para la nota de puente conceptual entre ambos proyectos'),
      overview: z.string().describe('Resumen de la sinergia e intersección temática'),
      sharedProblems: z.array(z.string()).describe('Problemas o preguntas de investigación comunes'),
      mutualBenefits: z.array(z.string()).describe('Cómo el Proyecto A enriquece al Proyecto B y viceversa'),
      markdownContent: z.string().describe('Cuerpo completo de la nota en formato Markdown con enlaces wikilink'),
    });

    const systemPrompt = `Eres un estratega de investigación interdisciplinaria y gestor de conocimiento para Obsidian.
Tu objetivo es analizar dos proyectos independientes de investigación y descubrir puentes conceptuales, transferencias metodológicas y sinergias creativas.
REGLAS:
1. Responde SIEMPRE en ESPAÑOL.
2. Utiliza wikilinks de Obsidian ([[nombre_nota]]).
3. Sé analítico, concreto y pragmático para el autor.`;

    const userMessage = `<PROYECTO_A>
Título: "${projA.title}"
Tesis: ${snapA?.thesisText || 'Sin tesis formal'}
Notas clave:
${notesA.map(n => `- [[${n.noteTitle}]]: ${(n.contentSnippet || '').substring(0, 300)}`).join('\n') || '(Sin notas registradas aún)'}
</PROYECTO_A>

<PROYECTO_B>
Título: "${projB.title}"
Tesis: ${snapB?.thesisText || 'Sin tesis formal'}
Notas clave:
${notesB.map(n => `- [[${n.noteTitle}]]: ${(n.contentSnippet || '').substring(0, 300)}`).join('\n') || '(Sin notas registradas aún)'}
</PROYECTO_B>

Propón un puente de investigación unificado entre ambos proyectos.`;

    let result;
    try {
      const evalResult = await sharedAiProvider.evaluateContent(systemPrompt, userMessage, synergySynthesisSchema);
      result = evalResult.data;
    } catch (err: any) {
      server.log.error({ err }, 'Error in cross-project synergy evaluation');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Error al sintetizar la sinergia entre proyectos con el modelo de IA.',
      });
    }

    let writtenToVault = false;
    let fileName: string | null = null;
    const vaultPath = getCurrentVaultPath();

    if (saveToVault && vaultPath) {
      try {
        const cleanA = projA.title.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').substring(0, 20);
        const cleanB = projB.title.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').substring(0, 20);
        fileName = `synergy_${cleanA}_${cleanB}.md`;

        const targetDir = path.join(vaultPath, 'Projects');
        const targetFilePath = path.join(targetDir, fileName);

        const frontmatter = `---
title: "${result.bridgeTitle.replace(/"/g, '\\"')}"
type: cross_project_synergy
project_a: "${projA.title}"
project_b: "${projB.title}"
created_at: "${new Date().toISOString()}"
tags:
  - loom/synergy
  - loom/cross-project
---

# ${result.bridgeTitle}

> [!abstract] Resonancia Temática
> ${result.overview.replace(/\n/g, '\n> ')}

## Preguntas y Problemas Compartidos
${result.sharedProblems.map((p: string) => `- ${p}`).join('\n')}

## Beneficios Mutuos y Transferencia
${result.mutualBenefits.map((b: string) => `- ${b}`).join('\n')}

${result.markdownContent}

---
*Generado automáticamente por Loom mediante análisis de sinergia cruzada entre [[${projA.title}]] y [[${projB.title}]].*
`;

        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(targetFilePath, frontmatter, 'utf-8');
        writtenToVault = true;
      } catch (err) {
        console.error('[Synergy] Failed to write bridge note to vault:', err);
      }
    }

    return reply.send({
      success: true,
      bridgeTitle: result.bridgeTitle,
      overview: result.overview,
      sharedProblems: result.sharedProblems,
      mutualBenefits: result.mutualBenefits,
      markdownContent: result.markdownContent,
      filePath: fileName,
      writtenToVault,
    });
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
