import { boss } from '../queue';
import { evaluateContentMatch } from '../evaluator';
import { getLogger } from '../observability/logger';

const log = getLogger('evaluation-worker');

const QUEUE_NAME = 'evaluate_content';

/** Some project evaluations failed: the job fails so pg-boss retries it (audit F-09). */
export class EvaluationIncompleteError extends Error {
  constructor(public failures: number) {
    super(`${failures} project evaluation(s) failed`);
    this.name = 'EvaluationIncompleteError';
  }
}

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
        // Projects evaluated on an earlier attempt are skipped, so a retry only redoes the failures
        const stats = await evaluateContentMatch(contentId, targetProjectId, {}, { traceId, attempt });
        if (stats.failures > 0) throw new EvaluationIncompleteError(stats.failures);
      } catch (error) {
        log.error({ err: error, contentId, traceId, attempt }, 'Evaluation job failed');
        throw error;
      }
    }
  });
  
  log.info({ queue: QUEUE_NAME, workerId }, 'Worker registered');
};
