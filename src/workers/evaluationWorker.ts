import { boss } from '../queue';
import { evaluateContentMatch } from '../evaluator';

const QUEUE_NAME = 'evaluate_content';

export const setupEvaluationWorker = async () => {
  const workerId = await boss.work(QUEUE_NAME, async (jobs: any) => {
    const jobArray = Array.isArray(jobs) ? jobs : [jobs];
    
    for (const job of jobArray) {
      if (!job || !job.data) continue;
      const { contentId, targetProjectId } = job.data as { contentId: string; targetProjectId?: string };
      
      try {
        await evaluateContentMatch(contentId, targetProjectId);
      } catch (error) {
        console.error(`[EvaluationWorker] Failed evaluation for content ${contentId}:`, error);
        throw error;
      }
    }
  });
  
  console.log(`Worker successfully registered for ${QUEUE_NAME} with ID: ${workerId}`);
};
