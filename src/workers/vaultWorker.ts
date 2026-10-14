import { boss } from '../queue';
import { syncProjectSuggestions } from '../vault/updater';
import { env } from '../config';

const QUEUE_NAME = 'sync_suggestions';

interface SyncSuggestionsData {
  projectId: string;
}

export const setupVaultWorker = async () => {
  const workerId = await boss.work(QUEUE_NAME, async (jobs: any) => {
    const jobArray = Array.isArray(jobs) ? jobs : [jobs];
    
    for (const job of jobArray) {
      if (!job || !job.data) continue;
      const { projectId } = job.data as SyncSuggestionsData;
      
      const vaultPath = process.env.VAULT_PATH || env.VAULT_PATH;
      if (!vaultPath) {
        console.error('[VaultWorker] VAULT_PATH is not defined. Cannot sync suggestions.');
        continue; // Don't throw, just ignore if no vault path is configured
      }

      try {
        await syncProjectSuggestions(projectId, vaultPath);
      } catch (error) {
        console.error(`[VaultWorker] Failed syncing suggestions for project ${projectId}:`, error);
        throw error;
      }
    }
  });
  
  console.log(`Worker successfully registered for ${QUEUE_NAME} with ID: ${workerId}`);
};
