import { boss } from '../queue';
import { syncProjectSuggestions } from '../vault/updater';
import { env } from '../config';
import { getLogger } from '../observability/logger';

const log = getLogger('vault-worker');

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
        log.error('VAULT_PATH is not set; cannot sync suggestions');
        continue; // Don't throw, just ignore if no vault path is configured
      }

      try {
        await syncProjectSuggestions(projectId, vaultPath);
      } catch (error) {
        log.error({ err: error, projectId }, 'Syncing suggestions failed');
        throw error;
      }
    }
  });
  
  log.info({ queue: QUEUE_NAME, workerId }, 'Worker registered');
};
