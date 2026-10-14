import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db';
import { actionSuggestions, projects, contents, evaluations, projectSnapshots } from '../../db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { writeAcceptedSuggestionToVault } from '../../vault/updater';
import { boss } from '../../queue';

const SuggestionItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectTitle: z.string().nullable().optional(),
  contentId: z.string().uuid(),
  contentTitle: z.string().nullable().optional(),
  contentUri: z.string().nullable().optional(),
  actionType: z.enum(['counter_argument', 'unblocker', 'evidence_citation', 'narrative_bridge', 'other']),
  targetFile: z.string(),
  observation: z.string(),
  suggestedAction: z.string(),
  status: z.enum(['pending', 'accepted', 'discarded', 'tentative']),
  userFeedback: z.string().nullable().optional(),
  writtenToVault: z.boolean(),
  resolvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  triageReasoning: z.string().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
});

const SuggestionDetailSchema = SuggestionItemSchema.extend({
  contentSummary: z.string().nullable().optional(),
  triageVerdict: z.enum(['irrelevant', 'tentative', 'actionable']).nullable().optional(),
});

const ListSuggestionsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(['active', 'pending', 'accepted', 'discarded', 'tentative']).default('active'),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const UpdateSuggestionBodySchema = z.object({
  status: z.enum(['accepted', 'discarded']),
  userFeedback: z.string().max(1000).optional(),
});

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function (server: FastifyInstance) {
  // 1. List Suggestions
  server.get('/api/suggestions', {
    schema: {
      querystring: ListSuggestionsQuerySchema,
      response: {
        200: z.object({
          items: z.array(SuggestionItemSchema),
          total: z.number(),
          limit: z.number(),
          offset: z.number(),
        }),
      },
    },
  }, async (request, reply) => {
    const { projectId, status, limit, offset } = request.query as z.infer<typeof ListSuggestionsQuerySchema>;

    // Helper: query tentative evaluations
    const getTentativeItems = async () => {
      const conds = [eq(evaluations.verdict, 'tentative')];
      if (projectId) conds.push(eq(projectSnapshots.projectId, projectId));
      const where = and(...conds);

      const rows = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        projectTitle: projects.title,
        contentId: contents.id,
        contentTitle: contents.title,
        contentUri: contents.uri,
        observation: sql<string>`'Evaluación tentativa: relación temática o exploratoria'`,
        suggestedAction: evaluations.triageReasoning,
        confidenceScore: evaluations.confidenceScore,
        triageReasoning: evaluations.triageReasoning,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
      .innerJoin(contents, eq(evaluations.contentId, contents.id))
      .where(where)
      .orderBy(desc(evaluations.evaluatedAt));

      return rows.map(r => ({
        id: r.id,
        projectId: r.projectId,
        projectTitle: r.projectTitle,
        contentId: r.contentId,
        contentTitle: r.contentTitle,
        contentUri: r.contentUri,
        actionType: 'other' as const,
        targetFile: 'tentative',
        observation: r.observation,
        suggestedAction: r.suggestedAction || 'Aporte exploratorio sin acción concreta definida.',
        status: 'tentative' as const,
        userFeedback: null,
        writtenToVault: false,
        resolvedAt: null,
        createdAt: r.createdAt.toISOString(),
        confidenceScore: r.confidenceScore,
        triageReasoning: r.triageReasoning,
      }));
    };

    // Helper: query irrelevant (LLM-discarded) evaluations
    const getIrrelevantItems = async () => {
      const conds = [eq(evaluations.verdict, 'irrelevant')];
      if (projectId) conds.push(eq(projectSnapshots.projectId, projectId));
      const where = and(...conds);

      const rows = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        projectTitle: projects.title,
        contentId: contents.id,
        contentTitle: contents.title,
        contentUri: contents.uri,
        observation: sql<string>`'Descarte por modelo: no aporta evidencia ni argumentos a la tesis'`,
        suggestedAction: evaluations.triageReasoning,
        confidenceScore: evaluations.confidenceScore,
        triageReasoning: evaluations.triageReasoning,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
      .innerJoin(contents, eq(evaluations.contentId, contents.id))
      .where(where)
      .orderBy(desc(evaluations.evaluatedAt));

      return rows.map(r => ({
        id: r.id,
        projectId: r.projectId,
        projectTitle: r.projectTitle,
        contentId: r.contentId,
        contentTitle: r.contentTitle,
        contentUri: r.contentUri,
        actionType: 'other' as const,
        targetFile: 'discarded',
        observation: r.observation,
        suggestedAction: r.suggestedAction || 'Descartado por el modelo LLM',
        status: 'discarded' as const,
        userFeedback: null,
        writtenToVault: false,
        resolvedAt: null,
        createdAt: r.createdAt.toISOString(),
        confidenceScore: r.confidenceScore,
        triageReasoning: r.triageReasoning,
      }));
    };

    // Helper: query action_suggestions
    const getSuggestionsItems = async (sugStatus?: 'pending' | 'accepted' | 'discarded') => {
      const conds = [];
      if (projectId) conds.push(eq(actionSuggestions.projectId, projectId));
      if (sugStatus) conds.push(eq(actionSuggestions.status, sugStatus));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const rows = await db.select({
        id: actionSuggestions.id,
        projectId: actionSuggestions.projectId,
        projectTitle: projects.title,
        contentId: actionSuggestions.contentId,
        contentTitle: contents.title,
        contentUri: contents.uri,
        actionType: actionSuggestions.actionType,
        targetFile: actionSuggestions.targetFile,
        observation: actionSuggestions.observation,
        suggestedAction: actionSuggestions.suggestedAction,
        status: actionSuggestions.status,
        userFeedback: actionSuggestions.userFeedback,
        writtenToVault: actionSuggestions.writtenToVault,
        resolvedAt: actionSuggestions.resolvedAt,
        createdAt: actionSuggestions.createdAt,
        confidenceScore: evaluations.confidenceScore,
        triageReasoning: evaluations.triageReasoning,
      })
      .from(actionSuggestions)
      .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
      .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
      .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
      .where(where)
      .orderBy(desc(actionSuggestions.createdAt));

      return rows.map(r => ({
        ...r,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    };

    if (status === 'tentative') {
      const items = await getTentativeItems();
      const paged = items.slice(offset, offset + limit);
      return reply.send({ items: paged, total: items.length, limit, offset });
    }

    if (status === 'discarded') {
      const userDiscarded = await getSuggestionsItems('discarded');
      const llmDiscarded = await getIrrelevantItems();
      const allDiscarded = [...userDiscarded, ...llmDiscarded].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const paged = allDiscarded.slice(offset, offset + limit);
      return reply.send({ items: paged, total: allDiscarded.length, limit, offset });
    }

    if (status === 'pending' || status === 'accepted') {
      const items = await getSuggestionsItems(status);
      const paged = items.slice(offset, offset + limit);
      return reply.send({ items: paged, total: items.length, limit, offset });
    }

    // Default: 'active' (All non-discarded items: pending actionable + tentative)
    const pendingItems = await getSuggestionsItems('pending');
    const tentativeItems = await getTentativeItems();
    const allActive = [...pendingItems, ...tentativeItems].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const paged = allActive.slice(offset, offset + limit);
    return reply.send({ items: paged, total: allActive.length, limit, offset });
  });

  // 2. Get Single Suggestion Detail
  server.get('/api/suggestions/:id', {
    schema: {
      params: IdParamSchema,
      response: {
        200: SuggestionDetailSchema,
        404: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;

    const rows = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      projectTitle: projects.title,
      contentId: actionSuggestions.contentId,
      contentTitle: contents.title,
      contentUri: contents.uri,
      contentSummary: contents.summary,
      actionType: actionSuggestions.actionType,
      targetFile: actionSuggestions.targetFile,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      status: actionSuggestions.status,
      userFeedback: actionSuggestions.userFeedback,
      writtenToVault: actionSuggestions.writtenToVault,
      resolvedAt: actionSuggestions.resolvedAt,
      createdAt: actionSuggestions.createdAt,
      triageReasoning: evaluations.triageReasoning,
      triageVerdict: evaluations.verdict,
      confidenceScore: evaluations.confidenceScore,
    })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
    .where(eq(actionSuggestions.id, id))
    .limit(1);

    if (rows.length === 0) {
      // Check if it is an evaluation row (tentative or irrelevant)
      const evalRows = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        projectTitle: projects.title,
        contentId: contents.id,
        contentTitle: contents.title,
        contentUri: contents.uri,
        contentSummary: contents.summary,
        triageReasoning: evaluations.triageReasoning,
        triageVerdict: evaluations.verdict,
        confidenceScore: evaluations.confidenceScore,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
      .innerJoin(contents, eq(evaluations.contentId, contents.id))
      .where(eq(evaluations.id, id))
      .limit(1);

      if (evalRows.length > 0) {
        const ev = evalRows[0];
        const status = ev.triageVerdict === 'tentative' ? ('tentative' as const) : ('discarded' as const);
        return reply.send({
          id: ev.id,
          projectId: ev.projectId,
          projectTitle: ev.projectTitle,
          contentId: ev.contentId,
          contentTitle: ev.contentTitle,
          contentUri: ev.contentUri,
          contentSummary: ev.contentSummary,
          actionType: 'other' as const,
          targetFile: status,
          observation: status === 'tentative' ? 'Evaluación tentativa' : 'Descarte analítico',
          suggestedAction: ev.triageReasoning || '',
          status,
          userFeedback: null,
          writtenToVault: false,
          resolvedAt: null,
          createdAt: ev.createdAt.toISOString(),
          triageReasoning: ev.triageReasoning,
          triageVerdict: ev.triageVerdict,
          confidenceScore: ev.confidenceScore,
        });
      }

      return reply.status(404).send({
        error: 'Not Found',
        message: `Suggestion with id ${id} not found`,
      });
    }

    const item = rows[0];
    return reply.send({
      ...item,
      resolvedAt: item.resolvedAt ? item.resolvedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
    });
  });

  // 3. Update Suggestion Status (Accept / Discard)
  // Only pending suggestions can be resolved. Repeating the same resolution is a no-op (200);
  // changing an already-resolved suggestion to a different status is rejected (409).
  server.patch('/api/suggestions/:id', {
    schema: {
      params: IdParamSchema,
      body: UpdateSuggestionBodySchema,
      response: {
        200: SuggestionItemSchema,
        404: z.object({ error: z.string(), message: z.string() }),
        409: z.object({ error: z.string(), message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as z.infer<typeof IdParamSchema>;
    const { status, userFeedback } = request.body as z.infer<typeof UpdateSuggestionBodySchema>;

    const [existing] = await db.select().from(actionSuggestions).where(eq(actionSuggestions.id, id)).limit(1);
    if (!existing) {
      // Check if it is an evaluation row (e.g. tentative)
      const [evalRow] = await db.select({
        id: evaluations.id,
        projectId: projectSnapshots.projectId,
        contentId: evaluations.contentId,
        triageReasoning: evaluations.triageReasoning,
        verdict: evaluations.verdict,
        confidenceScore: evaluations.confidenceScore,
        createdAt: evaluations.evaluatedAt,
      })
      .from(evaluations)
      .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
      .where(eq(evaluations.id, id))
      .limit(1);

      if (evalRow) {
        if (status === 'discarded') {
          await db.update(evaluations).set({ verdict: 'irrelevant' }).where(eq(evaluations.id, id));
          const [details] = await db.select({
            id: evaluations.id,
            projectId: projectSnapshots.projectId,
            projectTitle: projects.title,
            contentId: contents.id,
            contentTitle: contents.title,
            contentUri: contents.uri,
            actionType: sql<string>`'other'`,
            targetFile: sql<string>`'discarded'`,
            observation: sql<string>`'Descartado'`,
            suggestedAction: evaluations.triageReasoning,
            status: sql<string>`'discarded'`,
            userFeedback: sql<string | null>`null`,
            writtenToVault: sql<boolean>`false`,
            resolvedAt: sql<Date>`now()`,
            createdAt: evaluations.evaluatedAt,
            triageReasoning: evaluations.triageReasoning,
            confidenceScore: evaluations.confidenceScore,
          })
          .from(evaluations)
          .innerJoin(projectSnapshots, eq(evaluations.projectSnapshotId, projectSnapshots.id))
          .innerJoin(projects, eq(projectSnapshots.projectId, projects.id))
          .innerJoin(contents, eq(evaluations.contentId, contents.id))
          .where(eq(evaluations.id, id))
          .limit(1);

          return reply.send({
            ...details,
            actionType: 'other' as const,
            status: 'discarded' as const,
            resolvedAt: new Date().toISOString(),
            createdAt: details.createdAt.toISOString(),
          });
        } else if (status === 'accepted') {
          // Idempotency check: prevent duplicate suggestions on double click
          const existingSuggestion = await db.query.actionSuggestions.findFirst({
            where: eq(actionSuggestions.evaluationId, evalRow.id),
          });

          let currentSug = existingSuggestion;
          if (existingSuggestion) {
            const [updated] = await db.update(actionSuggestions)
              .set({
                status: 'accepted',
                userFeedback: userFeedback ?? existingSuggestion.userFeedback,
                resolvedAt: new Date(),
              })
              .where(eq(actionSuggestions.id, existingSuggestion.id))
              .returning();
            currentSug = updated;
          } else {
            const [newSug] = await db.insert(actionSuggestions).values({
              projectId: evalRow.projectId,
              contentId: evalRow.contentId,
              evaluationId: evalRow.id,
              actionType: 'narrative_bridge',
              targetFile: 'ideas.md',
              observation: 'Afinidad temática aceptada por el usuario',
              suggestedAction: evalRow.triageReasoning || 'Integrar conceptos clave en el proyecto',
              status: 'accepted',
              userFeedback: userFeedback ?? null,
              writtenToVault: false,
              resolvedAt: new Date(),
            }).returning();
            currentSug = newSug;
          }

          const vaultPath = process.env.VAULT_PATH;
          if (vaultPath && currentSug && !currentSug.writtenToVault) {
            try {
              await writeAcceptedSuggestionToVault(currentSug.id, vaultPath);
            } catch (err) {
              server.log.error({ err }, `Failed writing converted suggestion ${currentSug.id} to vault`);
            }
          }

          const [details] = await db.select({
            id: actionSuggestions.id,
            projectId: actionSuggestions.projectId,
            projectTitle: projects.title,
            contentId: actionSuggestions.contentId,
            contentTitle: contents.title,
            contentUri: contents.uri,
            actionType: actionSuggestions.actionType,
            targetFile: actionSuggestions.targetFile,
            observation: actionSuggestions.observation,
            suggestedAction: actionSuggestions.suggestedAction,
            status: actionSuggestions.status,
            userFeedback: actionSuggestions.userFeedback,
            writtenToVault: actionSuggestions.writtenToVault,
            resolvedAt: actionSuggestions.resolvedAt,
            createdAt: actionSuggestions.createdAt,
            triageReasoning: evaluations.triageReasoning,
            confidenceScore: evaluations.confidenceScore,
          })
          .from(actionSuggestions)
          .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
          .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
          .leftJoin(evaluations, eq(actionSuggestions.evaluationId, evaluations.id))
          .where(eq(actionSuggestions.id, currentSug.id))
          .limit(1);

          return reply.send({
            ...details,
            resolvedAt: details.resolvedAt ? details.resolvedAt.toISOString() : null,
            createdAt: details.createdAt.toISOString(),
          });
        }
      }

      return reply.status(404).send({
        error: 'Not Found',
        message: `Suggestion with id ${id} not found`,
      });
    }

    if (existing.status === 'pending') {
      // Atomic transition: only one concurrent request can move it out of 'pending'
      const transitioned = await db.update(actionSuggestions)
        .set({
          status,
          userFeedback: userFeedback ?? existing.userFeedback,
          resolvedAt: new Date(),
        })
        .where(and(eq(actionSuggestions.id, id), eq(actionSuggestions.status, 'pending')))
        .returning({ id: actionSuggestions.id });

      if (transitioned.length === 0) {
        // Lost a race with another request; fall through to the resolved-state checks below
        const [current] = await db.select().from(actionSuggestions).where(eq(actionSuggestions.id, id)).limit(1);
        if (current.status !== status) {
          return reply.status(409).send({
            error: 'Conflict',
            message: `Suggestion was already resolved as '${current.status}'`,
          });
        }
      }
    } else if (existing.status !== status) {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Suggestion was already resolved as '${existing.status}'`,
      });
    }

    // Writeback (idempotent: no-op if already written)
    if (status === 'accepted') {
      const vaultPath = process.env.VAULT_PATH;
      if (vaultPath) {
        try {
          await writeAcceptedSuggestionToVault(id, vaultPath);
        } catch (vaultError) {
          server.log.error(vaultError, `Failed writing accepted suggestion ${id} to vault; queued for retry`);
          await boss.send('sync_suggestions', { projectId: existing.projectId }).catch(() => {});
        }
      } else {
        server.log.warn(`VAULT_PATH not set; accepted suggestion ${id} not written to vault`);
      }
    }

    const [updatedRow] = await db.select({
      id: actionSuggestions.id,
      projectId: actionSuggestions.projectId,
      projectTitle: projects.title,
      contentId: actionSuggestions.contentId,
      contentTitle: contents.title,
      contentUri: contents.uri,
      actionType: actionSuggestions.actionType,
      targetFile: actionSuggestions.targetFile,
      observation: actionSuggestions.observation,
      suggestedAction: actionSuggestions.suggestedAction,
      status: actionSuggestions.status,
      userFeedback: actionSuggestions.userFeedback,
      writtenToVault: actionSuggestions.writtenToVault,
      resolvedAt: actionSuggestions.resolvedAt,
      createdAt: actionSuggestions.createdAt,
    })
    .from(actionSuggestions)
    .innerJoin(projects, eq(actionSuggestions.projectId, projects.id))
    .innerJoin(contents, eq(actionSuggestions.contentId, contents.id))
    .where(eq(actionSuggestions.id, id))
    .limit(1);

    return reply.send({
      ...updatedRow,
      resolvedAt: updatedRow.resolvedAt ? updatedRow.resolvedAt.toISOString() : null,
      createdAt: updatedRow.createdAt.toISOString(),
    });
  });
}
