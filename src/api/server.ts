import Fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import ingestRoute from './routes/ingest';
import suggestionsRoute from './routes/suggestions';
import projectsRoute from './routes/projects';
import contentsRoute from './routes/contents';
import settingsRoute from './routes/settings';
import systemRoute from './routes/system';
import fastifyStatic from '@fastify/static';
import * as path from 'path';
import { startQueue } from '../queue';
import { setupIngestionWorker } from '../workers/ingestionWorker';
import { setupEvaluationWorker } from '../workers/evaluationWorker';
import { setupVaultWorker } from '../workers/vaultWorker';
import { startVaultWatcher } from '../vault';

export const server = Fastify({
  logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL || 'warn' }
}).withTypeProvider<ZodTypeProvider>();

// Add Zod validation compilers
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

// Custom error handler
server.setErrorHandler((error: any, request, reply) => {
  if (error.validation) {
    reply.status(400).send({
      error: 'Bad Request',
      message: 'Validation failed',
      issues: error.validation
    });
    return;
  }
  
  const statusCode = error.statusCode || 500;
  server.log.error(error);
  reply.status(statusCode).send({
    error: statusCode === 500 ? 'Internal Server Error' : error.name || 'Error',
    message: error.message || 'An unexpected error occurred',
  });
});

server.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

server.get('/favicon.ico', async (request, reply) => {
  return reply.status(204).send();
});

const QuerySchema = z.object({
  echo: z.string().optional()
});

server.get('/ping', {
  schema: {
    querystring: QuerySchema,
    response: {
      200: z.object({ message: z.string() })
    }
  }
}, async (request, reply) => {
  const { echo } = request.query;
  return { message: echo ? `Pong: ${echo}` : 'Pong' };
});

// Register routes
server.register(ingestRoute);
server.register(contentsRoute);
server.register(suggestionsRoute);
server.register(projectsRoute);
server.register(settingsRoute);
server.register(systemRoute);

// Serve static frontend files from web/
server.register(fastifyStatic, {
  root: path.resolve(__dirname, '../../web'),
  prefix: '/',
  index: 'index.html',
});

export const startServer = async () => {
  try {
    // Start pg-boss queue and workers
    await startQueue();
    await setupIngestionWorker();
    await setupEvaluationWorker();
    await setupVaultWorker();
    
    // Start Obsidian Vault Watcher if VAULT_PATH is provided
    if (process.env.VAULT_PATH) {
      startVaultWatcher(process.env.VAULT_PATH).catch(err => {
        server.log.error({ err }, 'Vault Watcher Error:');
      });
    } else {
      server.log.warn('VAULT_PATH is not set. Skipping Obsidian Sync Watcher.');
    }

    const host = process.env.HOST || '127.0.0.1';
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host });
    console.log(`Server listening on http://${host}:${port}`);
  } catch (err) {
    server.log.error({ err });
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}
