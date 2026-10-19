import { boss } from '../queue';
import { evaluateContentMatch } from '../evaluator';
import { getLogger } from '../observability/logger';

const log = getLogger('evaluation-worker');

const QUEUE_NAME = 'evaluate_content';

interface EvaluateContentData {
  contentId: string;
  targetProjectId?: string;
  traceId?: string;
}

export const setupEvaluationWorker = async () => {
  const workerId = await boss.work(QUEUE_NAME, async (jobs: any) => {
    const jobArray = Array.isArray(jobs) ? jobs : [jobs];
    
    for (const job of jobArray) {
      if (!job || !job.data) continue;
      const { contentId, targetProjectId, traceId } = job.data as EvaluateContentData;
      const attempt = typeof job.retryCount === 'number' ? job.retryCount + 1 : undefined;

      try {
        await evaluateContentMatch(contentId, targetProjectId, {}, { traceId, attempt });
      } catch (error) {
        log.error({ err: error, contentId, traceId, attempt }, 'Evaluation job failed');
        throw error;
      }
    }
  });
  
  log.info({ queue: QUEUE_NAME, workerId }, 'Worker registered');
};
