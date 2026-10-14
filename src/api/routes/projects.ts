import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { projects, projectSnapshots, actionSuggestions, evaluations } from '../../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';

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
      inArray(evaluations.verdict, ['tentative', 'irrelevant'])
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
        eq(evaluations.verdict, 'tentative')
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
}
