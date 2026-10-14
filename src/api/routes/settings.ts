import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '../../db';
import { projects, actionSuggestions } from '../../db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  getCurrentVaultPath,
  validateVaultPath,
  persistVaultPath,
} from '../../vault/config';
import {
  isVaultWatcherActive,
  restartVaultWatcher,
} from '../../vault/watcher';
import { reconcileAllProjects } from '../../vault/reconciler';

const ProjectVaultInfoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  folderPath: z.string(),
  isActive: z.boolean(),
  existsOnDisk: z.boolean(),
  suggestionsCount: z.number(),
});

const GetVaultSettingsResponseSchema = z.object({
  vaultPath: z.string().nullable(),
  isConfigured: z.boolean(),
  isValid: z.boolean(),
  hasProjectsDir: z.boolean(),
  projectsDirName: z.string().nullable(),
  watcherActive: z.boolean(),
  projects: z.array(ProjectVaultInfoSchema),
});

const UpdateVaultBodySchema = z.object({
  vaultPath: z.string().min(1, 'La ruta del vault es obligatoria'),
});

export default async function (server: FastifyInstance) {
  // 1. GET Current Vault Settings & Project Status
  server.get('/api/settings/vault', {
    schema: {
      response: {
        200: GetVaultSettingsResponseSchema,
      },
    },
  }, async (request, reply) => {
    const currentVaultPath = getCurrentVaultPath();

    if (!currentVaultPath) {
      return {
        vaultPath: null,
        isConfigured: false,
        isValid: false,
        hasProjectsDir: false,
        projectsDirName: null,
        watcherActive: false,
        projects: [],
      };
    }

    const pathStatus = await validateVaultPath(currentVaultPath);
    const watcherActive = isVaultWatcherActive();

    const allProjects = await db.select().from(projects).orderBy(projects.title);
    const projectDetails = [];

    for (const proj of allProjects) {
      let existsOnDisk = false;
      if (pathStatus.isValid) {
        try {
          const stat = await fs.stat(path.join(currentVaultPath, proj.folderPath));
          existsOnDisk = stat.isDirectory();
        } catch {
          existsOnDisk = false;
        }
      }

      const [countResult] = await db.select({
        count: sql<number>`count(*)::int`,
      })
      .from(actionSuggestions)
      .where(eq(actionSuggestions.projectId, proj.id));

      projectDetails.push({
        id: proj.id,
        title: proj.title,
        folderPath: proj.folderPath,
        isActive: proj.isActive,
        existsOnDisk,
        suggestionsCount: countResult?.count || 0,
      });
    }

    return {
      vaultPath: pathStatus.vaultPath,
      isConfigured: true,
      isValid: pathStatus.isValid,
      hasProjectsDir: pathStatus.hasProjectsDir,
      projectsDirName: pathStatus.projectsDirName,
      watcherActive,
      projects: projectDetails,
    };
  });

  // 2. POST /api/settings/vault: Change or Set Vault Path
  server.post('/api/settings/vault', {
    schema: {
      body: UpdateVaultBodySchema,
    },
  }, async (request, reply) => {
    const { vaultPath } = request.body as z.infer<typeof UpdateVaultBodySchema>;

    const validation = await validateVaultPath(vaultPath);

    if (!validation.isValid || !validation.vaultPath) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'La ruta especificada no existe o no es un directorio válido en el sistema de archivos.',
      });
    }

    // Persist new path in process.env and .env file
    const persistedPath = await persistVaultPath(validation.vaultPath);

    // Restart the watcher with the new path
    await restartVaultWatcher(persistedPath);

    // Reconcile all projects with the new vault location
    const syncStatuses = await reconcileAllProjects(persistedPath);

    const activeCount = syncStatuses.filter(p => p.isActive && p.existsOnDisk).length;
    const missingCount = syncStatuses.filter(p => !p.existsOnDisk).length;

    let message = `Vault configurado y sincronizado. Se detectaron ${activeCount} proyecto(s) activo(s).`;
    if (missingCount > 0) {
      message += ` (${missingCount} proyecto(s) previo(s) no se encuentran en este directorio y fueron marcados como inactivos).`;
    }

    return {
      success: true,
      vaultPath: persistedPath,
      hasProjectsDir: validation.hasProjectsDir,
      projectsDirName: validation.projectsDirName,
      watcherActive: true,
      projects: syncStatuses,
      summary: {
        activeProjects: activeCount,
        missingProjects: missingCount,
        message,
      },
    };
  });

  // 3. POST /api/settings/vault/rescan: Force Re-scan Current Vault
  server.post('/api/settings/vault/rescan', async (request, reply) => {
    const currentVaultPath = getCurrentVaultPath();

    if (!currentVaultPath) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No hay ninguna ruta de Vault configurada para escanear.',
      });
    }

    const validation = await validateVaultPath(currentVaultPath);
    if (!validation.isValid) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'La ruta actual del Vault ya no existe o no es accesible.',
      });
    }

    const syncStatuses = await reconcileAllProjects(currentVaultPath, true);
    return {
      success: true,
      vaultPath: currentVaultPath,
      projects: syncStatuses,
    };
  });
}
