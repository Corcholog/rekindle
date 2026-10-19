import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { db } from '../../db';
import { projects, actionSuggestions } from '../../db/schema';
import { sql } from 'drizzle-orm';
import {
  getCurrentVaultPath,
  validateVaultPath,
  persistVaultPath,
  persistEnvSetting,
  isSafeEnvValue,
} from '../../vault/config';
import {
  isVaultWatcherActive,
  restartVaultWatcher,
} from '../../vault/watcher';
import { reconcileAllProjects } from '../../vault/reconciler';
import { LANGUAGES, notesLanguage, outputLanguage, presetLanguage } from '../../ai/language';

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
  vaultPath: z.string()
    .min(1, 'The vault path is required')
    .refine(isSafeEnvValue, 'The vault path cannot contain line breaks or control characters'),
});

const LanguageSettingsSchema = z.object({
  /** Default for the UI and for the two settings below (LANGUAGE in .env). */
  preset: z.enum(LANGUAGES),
  outputLanguage: z.enum(LANGUAGES),
  notesLanguage: z.enum(LANGUAGES),
});

const UpdateLanguageBodySchema = z.object({
  outputLanguage: z.enum(LANGUAGES).optional(),
  notesLanguage: z.enum(LANGUAGES).optional(),
}).refine(body => body.outputLanguage !== undefined || body.notesLanguage !== undefined, {
  message: 'Nothing to update',
});

const currentLanguages = () => ({ preset: presetLanguage(), outputLanguage: outputLanguage(), notesLanguage: notesLanguage() });

export default async function (server: FastifyInstance) {
  // Languages: what generated text is written in, and what the notes are written in (summaries
  // follow the notes, so retrieval compares like with like). Applies to new generations only.
  server.get('/api/settings/language', {
    schema: { response: { 200: LanguageSettingsSchema } },
  }, async () => currentLanguages());

  server.put('/api/settings/language', {
    schema: { body: UpdateLanguageBodySchema, response: { 200: LanguageSettingsSchema } },
  }, async (request) => {
    const body = request.body as z.infer<typeof UpdateLanguageBodySchema>;
    if (body.outputLanguage) await persistEnvSetting('OUTPUT_LANGUAGE', body.outputLanguage);
    if (body.notesLanguage) await persistEnvSetting('NOTES_LANGUAGE', body.notesLanguage);
    return currentLanguages();
  });

  // 1. GET Current Vault Settings & Project Status
  server.get('/api/settings/vault', {
    schema: {
      response: {
        200: GetVaultSettingsResponseSchema,
      },
    },
  }, async (_request, _reply) => {
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
    const countRows = await db.select({
      projectId: actionSuggestions.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(actionSuggestions)
    .groupBy(actionSuggestions.projectId);

    const countMap = new Map<string, number>(countRows.map(r => [r.projectId, r.count]));
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

      projectDetails.push({
        id: proj.id,
        title: proj.title,
        folderPath: proj.folderPath,
        isActive: proj.isActive,
        existsOnDisk,
        suggestionsCount: countMap.get(proj.id) ?? 0,
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
        message: 'The path does not exist or is not a directory.',
        code: 'vault_path_invalid',
      });
    }

    // Persist new path in process.env and .env file
    const persistedPath = await persistVaultPath(validation.vaultPath);

    // Restart the watcher with the new path without duplicating initial reconcile
    await restartVaultWatcher(persistedPath, false);

    // Reconcile all projects with the new vault location
    const syncStatuses = await reconcileAllProjects(persistedPath);

    const activeCount = syncStatuses.filter(p => p.isActive && p.existsOnDisk).length;
    const missingCount = syncStatuses.filter(p => !p.existsOnDisk).length;

    let message = `Vault configured and synchronized: ${activeCount} active project(s).`;
    if (missingCount > 0) {
      message += ` ${missingCount} earlier project(s) are not in this folder and were marked inactive.`;
    }

    return {
      success: true,
      vaultPath: persistedPath,
      hasProjectsDir: validation.hasProjectsDir,
      projectsDirName: validation.projectsDirName,
      watcherActive: isVaultWatcherActive(),
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
        message: 'No vault path is configured to scan.',
        code: 'vault_not_configured',
      });
    }

    const validation = await validateVaultPath(currentVaultPath);
    if (!validation.isValid) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'The current vault path no longer exists or is not accessible.',
        code: 'vault_path_missing',
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
