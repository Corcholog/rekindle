import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '../../db';
import { projects, projectSnapshots, projectNoteSnapshots, actionSuggestions, evaluations, contents } from '../../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { getCurrentVaultPath } from '../../vault/config';
import { env } from '../../config';
import { writeGeneratedNote, formatResearchBrief, formatSynergyNote } from '../../vault/generatedNotes';
import { sharedAiProvider } from '../../ai/aiProvider';
import { languageName, outputLanguage } from '../../ai/language';
import { SERVER_TEXT, serverText } from '../../i18n/serverText';
import { promptBlock } from '../../ai/promptSafety';

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
  hasExistingBridge: z.boolean().optional(),
  bridgeFilePath: z.string().nullable().optional(),
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

// Bridge notes live in the vault's projects directory (Projects/ or Proyectos/) of project A.
function synergyDirFor(vaultPath: string, folderPath: string): string {
  return path.join(vaultPath, folderPath.split('/')[0]);
}

function getSynergyFileNames(titleA: string, titleB: string): [string, string] {
  const cleanA = titleA.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').substring(0, 20);
  const cleanB = titleB.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').substring(0, 20);
  return [`synergy_${cleanA}_${cleanB}.md`, `synergy_${cleanB}_${cleanA}.md`];
}

// Saved notes may be in either language: match the headings of both
const headingAlternatives = (key: 'synergyProblems' | 'synergyBenefits') =>
  Object.values(SERVER_TEXT).map(text => text[key]).join('|');
const PROBLEMS_HEADING = headingAlternatives('synergyProblems');
const BENEFITS_HEADING = headingAlternatives('synergyBenefits');

export function parseExistingBridgeFile(fileName: string, content: string) {
  const titleMatch = content.match(/^title:\s*"([^"]+)"/m) || content.match(/^#\s+(.+)$/m);
  const bridgeTitle = titleMatch ? titleMatch[1].trim() : path.basename(fileName, '.md');

  let overview = '';
  const abstractMatch = content.match(/>\s*\[!abstract\][^\n]*\n((?:>\s*[^\n]*\n?)+)/i);
  if (abstractMatch) {
    overview = abstractMatch[1]
      .split('\n')
      .map(line => line.replace(/^>\s?/, '').trim())
      .filter(Boolean)
      .join('\n');
  }

  const sharedProblems: string[] = [];
  const problemsMatch = content.match(new RegExp(`## (?:${PROBLEMS_HEADING})[ \\t]*\\n((?:[ \\t]*[-*][^\\n]*(?:\\n|$))*)`, 'i'));
  if (problemsMatch) {
    const lines = problemsMatch[1].split('\n');
    for (const l of lines) {
      const trimmed = l.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').trim();
      if (trimmed) sharedProblems.push(trimmed);
    }
  }

  const mutualBenefits: string[] = [];
  const benefitsMatch = content.match(new RegExp(`## (?:${BENEFITS_HEADING})[ \\t]*\\n((?:[ \\t]*[-*][^\\n]*(?:\\n|$))*)`, 'i'));
  if (benefitsMatch) {
    const lines = benefitsMatch[1].split('\n');
    for (const l of lines) {
      const trimmed = l.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').trim();
      if (trimmed) mutualBenefits.push(trimmed);
    }
  }

  let markdownContent = '';
  const afterBenefitsMatch = content.match(new RegExp(`## (?:${BENEFITS_HEADING})[\\s\\S]*?\\n\\n([\\s\\S]*?)(?=\\n---\\n\\*(?:Generado|Generated)|$)`, 'i'));
  if (afterBenefitsMatch) {
    markdownContent = afterBenefitsMatch[1].trim();
  } else {
    markdownContent = content.replace(/^---[\s\S]*?---\n*/, '').trim();
  }

  return {
    bridgeTitle,
    overview: overview || serverText().savedSynergyOverview,
    sharedProblems: sharedProblems.length > 0 ? sharedProblems : [serverText().savedSynergyProblem],
    mutualBenefits: mutualBenefits.length > 0 ? mutualBenefits : [serverText().savedSynergyBenefit],
    markdownContent,
  };
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

    // 3. Count evaluations (tentative and irrelevant) with strict deduplication
    const evalCountRes = await db.execute<{
      project_id: string;
      verdict: string;
      count: number;
    }>(sql`
      WITH latest_project_evals AS (
        SELECT DISTINCT ON (e.content_id, ps.project_id)
          e.id,
          e.content_id,
          ps.project_id,
          e.verdict
        FROM ${evaluations} e
        JOIN ${projectSnapshots} ps ON e.project_snapshot_id = ps.id
        WHERE ps.project_id IN (${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})
        ORDER BY e.content_id, ps.project_id, e.evaluated_at DESC
      )
      SELECT 
        project_id,
        verdict,
        count(*)::int AS count
      FROM latest_project_evals lpe
      WHERE (
        (lpe.verdict = 'tentative' AND NOT EXISTS (
          SELECT 1 FROM ${actionSuggestions} a 
          WHERE a.evaluation_id = lpe.id
        ))
        OR
        (lpe.verdict = 'irrelevant' AND NOT EXISTS (
          SELECT 1 FROM ${actionSuggestions} a 
          WHERE a.evaluation_id = lpe.id
        ))
      )
      GROUP BY project_id, verdict
    `);

    const evalCounts = new Map<string, number>();
    for (const e of evalCountRes.rows) {
      if (e.verdict) {
        evalCounts.set(`${e.project_id}:${e.verdict}`, e.count);
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
        message: 'At least two active projects with indexed notes are needed to compute synergies.',
        code: 'synergy_needs_two_projects',
      });
    }

    // Get latest snapshots per project with embeddings
    const projectIds = activeProjects.map(p => p.id);
    const snaps = await db.select({
      id: projectSnapshots.id,
      projectId: projectSnapshots.projectId,
      thesisText: projectSnapshots.thesisText,
      embedding: projectSnapshots.embedding,
      embeddingModel: projectSnapshots.embeddingModel,
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

        // Invariant I7: only compare snapshots embedded with the current model
        const comparable = snapA?.embeddingModel === env.EMBED_MODEL && snapB?.embeddingModel === env.EMBED_MODEL;
        const projectDist = comparable ? computeCosineDistance(snapA?.embedding, snapB?.embedding) : null;

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
            AND na.embedding_model = ${env.EMBED_MODEL} AND nb.embedding_model = ${env.EMBED_MODEL}
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
          rationale = serverText().synergyNoteRationale(closestNotes[0].noteATitle, pA.title, closestNotes[0].noteBSTitle, pB.title);
        } else {
          rationale = serverText().synergyProjectRationale(pA.title, pB.title);
        }

        const [f1, f2] = getSynergyFileNames(pA.title, pB.title);
        let existingBridgeFile: string | null = null;
        const vaultPath = getCurrentVaultPath();
        if (vaultPath) {
          try {
            const p1 = path.join(synergyDirFor(vaultPath, pA.folderPath), f1);
            const p2 = path.join(synergyDirFor(vaultPath, pA.folderPath), f2);
            if (await fs.access(p1).then(() => true).catch(() => false)) {
              existingBridgeFile = f1;
            } else if (await fs.access(p2).then(() => true).catch(() => false)) {
              existingBridgeFile = f2;
            }
          } catch (accessErr) {
            server.log.debug({ err: accessErr }, 'Bridge file access check failed');
          }
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
          hasExistingBridge: Boolean(existingBridgeFile),
          bridgeFilePath: existingBridgeFile,
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
        forceRegenerate: z.boolean().optional().default(false),
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
          isCached: z.boolean().optional(),
        }),
        404: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
        500: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
      },
    },
  }, async (request, reply) => {
    const { projectAId, projectBId, forceRegenerate = false } = request.body as any;

    const [projA] = await db.select().from(projects).where(eq(projects.id, projectAId)).limit(1);
    const [projB] = await db.select().from(projects).where(eq(projects.id, projectBId)).limit(1);

    if (!projA || !projB) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'One or both projects were not found.',
        code: 'project_not_found',
      });
    }

    const vaultPath = getCurrentVaultPath();
    const [fileA, fileB] = getSynergyFileNames(projA.title, projB.title);

    // If not forcing regeneration, check if bridge already exists on disk in Obsidian Vault
    if (!forceRegenerate && vaultPath) {
      try {
        const bridgeDir = synergyDirFor(vaultPath, projA.folderPath);
        const pathA = path.join(bridgeDir, fileA);
        const pathB = path.join(bridgeDir, fileB);

        let existingPath: string | null = null;
        let existingFileName: string | null = null;

        if (await fs.access(pathA).then(() => true).catch(() => false)) {
          existingPath = pathA;
          existingFileName = fileA;
        } else if (await fs.access(pathB).then(() => true).catch(() => false)) {
          existingPath = pathB;
          existingFileName = fileB;
        }

        if (existingPath && existingFileName) {
          const rawContent = await fs.readFile(existingPath, 'utf-8');
          const parsed = parseExistingBridgeFile(existingFileName, rawContent);
          return reply.send({
            success: true,
            bridgeTitle: parsed.bridgeTitle,
            overview: parsed.overview,
            sharedProblems: parsed.sharedProblems,
            mutualBenefits: parsed.mutualBenefits,
            markdownContent: parsed.markdownContent,
            filePath: path.relative(vaultPath, existingPath).replace(/\\/g, '/'),
            writtenToVault: true,
            isCached: true,
          });
        }
      } catch (err) {
        server.log.warn({ err }, 'Could not read existing synergy file, proceeding to generate');
      }
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
1. Responde SIEMPRE en ${languageName(outputLanguage()).upper}.
2. Utiliza wikilinks de Obsidian ([[nombre_nota]]).
3. Sé analítico, concreto y pragmático para el autor.`;

    const userMessage = `${promptBlock('PROYECTO_A', `Título: "${projA.title}"
Tesis: ${snapA?.thesisText || 'Sin tesis formal'}
Notas clave:
${notesA.map(n => `- [[${n.noteTitle}]]: ${(n.contentSnippet || '').substring(0, 300)}`).join('\n') || '(Sin notas registradas aún)'}`)}

${promptBlock('PROYECTO_B', `Título: "${projB.title}"
Tesis: ${snapB?.thesisText || 'Sin tesis formal'}
Notas clave:
${notesB.map(n => `- [[${n.noteTitle}]]: ${(n.contentSnippet || '').substring(0, 300)}`).join('\n') || '(Sin notas registradas aún)'}`)}

Propón un puente de investigación unificado entre ambos proyectos.`;

    let result;
    try {
      const evalResult = await sharedAiProvider.evaluateContent(systemPrompt, userMessage, synergySynthesisSchema, undefined, { component: 'synergy' });
      result = evalResult.data;
    } catch (err: any) {
      server.log.error({ err }, 'Error in cross-project synergy evaluation');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'The language model failed to synthesize the synergy between the projects.',
        code: 'llm_failed',
      });
    }

    // Generation never writes to the vault; saving is an explicit action (POST /api/projects/synergies/save)
    return reply.send({
      success: true,
      bridgeTitle: result.bridgeTitle,
      overview: result.overview,
      sharedProblems: result.sharedProblems,
      mutualBenefits: result.mutualBenefits,
      markdownContent: result.markdownContent,
      filePath: null,
      writtenToVault: false,
      isCached: false,
    });
  });

  // 1.7 Explicitly save a bridge note shown in the UI (never overwrites an existing file)
  server.post('/api/projects/synergies/save', {
    schema: {
      body: z.object({
        projectAId: z.string().uuid(),
        projectBId: z.string().uuid(),
        bridgeTitle: z.string().min(1).max(300),
        overview: z.string().max(20000),
        sharedProblems: z.array(z.string().max(2000)).max(30),
        mutualBenefits: z.array(z.string().max(2000)).max(30),
        markdownContent: z.string().max(40000),
      }),
      response: {
        200: z.object({ success: z.boolean(), filePath: z.string() }),
        400: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
        404: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      projectAId: string; projectBId: string; bridgeTitle: string; overview: string;
      sharedProblems: string[]; mutualBenefits: string[]; markdownContent: string;
    };

    const [projA] = await db.select().from(projects).where(eq(projects.id, body.projectAId)).limit(1);
    const [projB] = await db.select().from(projects).where(eq(projects.id, body.projectBId)).limit(1);
    if (!projA || !projB) {
      return reply.status(404).send({ error: 'Not Found', message: 'One or both projects were not found.', code: 'project_not_found' });
    }

    const vaultPath = getCurrentVaultPath();
    if (!vaultPath) {
      return reply.status(400).send({ error: 'Bad Request', message: 'No Obsidian vault is configured.', code: 'vault_not_configured' });
    }

    const [fileName] = getSynergyFileNames(projA.title, projB.title);
    const filePath = await writeGeneratedNote(
      synergyDirFor(vaultPath, projA.folderPath),
      vaultPath,
      fileName.replace(/\.md$/, ''),
      formatSynergyNote(body, projA.title, projB.title),
    );
    return reply.send({ success: true, filePath });
  });

  const synthesisSchema = z.object({
    title: z.string().describe('Título claro y representativo para el brief de investigación del proyecto'),
    executiveSummary: z.string().describe('Resumen ejecutivo de 1 o 2 párrafos que unifica las contribuciones aceptadas'),
    markdownContent: z.string().describe('Cuerpo en formato markdown con encabezados de sección, síntesis de evidencias, contraargumentos superados y conexiones entre borradores'),
    suggestedNextSteps: z.array(z.string()).describe('Lista de 3 a 5 tareas accionables recomendadas para continuar la redacción del proyecto'),
  });

  const SynthesizeResponseSchema = z.object({
    success: z.boolean(),
    filePath: z.string().nullable(),
    title: z.string(),
    executiveSummary: z.string(),
    markdownContent: z.string(),
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
          code: z.string().optional(),
        }),
        404: z.object({
          error: z.string(),
          message: z.string().optional(),
          code: z.string().optional(),
        }),
        500: z.object({
          error: z.string(),
          message: z.string().optional(),
          code: z.string().optional(),
        }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [proj] = await db.select().from(projects).where(eq(projects.id, id));
    if (!proj) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found', code: 'project_not_found' });
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
        message: 'This project has no accepted suggestions to synthesize. Accept at least one suggestion first.',
        code: 'nothing_to_synthesize',
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
1. Responde SIEMPRE en ${languageName(outputLanguage()).upper}.
2. Integra los aportes, citas de evidencia y contraargumentos en una narrativa de investigación lógica.
3. Utiliza formato Markdown con títulos claros, listas y wikilinks de Obsidian como [[${proj.title}]] o [[notas_relevantes]].
4. Sé exhaustivo pero conciso, facilitando al autor la redacción de sus borradores.`;

    const userMessage = `${promptBlock('CONTEXTO_DEL_PROYECTO', `Proyecto: "${proj.title}"
Notas y Borradores Actuales:
${projectContext.substring(0, 10000)}`)}

${promptBlock('SUGERENCIAS_ACEPTADAS_A_SINTETIZAR', `Total de sugerencias aceptadas: ${acceptedList.length}

${suggestionsPrompt}`)}`;

    let result;
    try {
      const evalResult = await sharedAiProvider.evaluateContent(systemPrompt, userMessage, synthesisSchema, undefined, { component: 'synthesis' });
      result = evalResult.data;
    } catch (err: any) {
      server.log.error({ err }, 'Error generating project synthesis via LLM');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'The language model failed to generate the project synthesis.',
        code: 'llm_failed',
      });
    }

    // Generation never writes to the vault; saving is an explicit action (POST /api/projects/:id/synthesis/save)
    return reply.send({
      success: true,
      filePath: null,
      title: result.title,
      executiveSummary: result.executiveSummary,
      markdownContent: result.markdownContent,
      suggestedNextSteps: result.suggestedNextSteps || [],
      acceptedCount: acceptedList.length,
      writtenToVault: false,
    });
  });

  // 4. Explicitly save a research brief shown in the UI (never overwrites an existing file)
  server.post('/api/projects/:id/synthesis/save', {
    schema: {
      params: IdParamSchema,
      body: z.object({
        title: z.string().min(1).max(300),
        executiveSummary: z.string().max(20000),
        markdownContent: z.string().max(40000),
        suggestedNextSteps: z.array(z.string().max(2000)).max(30),
        acceptedCount: z.number().int().min(0).optional().default(0),
      }),
      response: {
        200: z.object({ success: z.boolean(), filePath: z.string() }),
        400: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
        404: z.object({ error: z.string(), message: z.string(), code: z.string().optional() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      title: string; executiveSummary: string; markdownContent: string;
      suggestedNextSteps: string[]; acceptedCount: number;
    };

    const [proj] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!proj) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found', code: 'project_not_found' });
    }

    const vaultPath = getCurrentVaultPath();
    if (!vaultPath) {
      return reply.status(400).send({ error: 'Bad Request', message: 'No Obsidian vault is configured.', code: 'vault_not_configured' });
    }

    const filePath = await writeGeneratedNote(
      path.join(vaultPath, proj.folderPath),
      vaultPath,
      'research_brief',
      formatResearchBrief(body, body.acceptedCount),
    );
    return reply.send({ success: true, filePath });
  });
}
