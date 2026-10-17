import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import ingestRoute from './routes/ingest';
import suggestionsRoute from './routes/suggestions';
import projectsRoute from './routes/projects';
import contentsRoute from './routes/contents';
import settingsRoute from './routes/settings';
import systemRoute from './routes/system';
import libraryRoute from './routes/library';
import fastifyStatic from '@fastify/static';
import * as path from 'path';
import { startQueue, boss } from '../queue';
import { pool } from '../db';
import { setupIngestionWorker } from '../workers/ingestionWorker';
import { setupEvaluationWorker } from '../workers/evaluationWorker';
import { setupVaultWorker } from '../workers/vaultWorker';
import { startVaultWatcher, stopVaultWatcher } from '../vault/watcher';
import { env } from '../config';

export const server = Fastify({
  logger: env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL || 'warn' }
}).withTypeProvider<ZodTypeProvider>();

// Add Zod validation compilers
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

// Custom error handler
server.setErrorHandler((error: any, request, reply) => {
  if (error.validation) {
    const issueMsg = error.validation?.[0]?.message;
    reply.status(400).send({
      error: 'Bad Request',
      message: issueMsg ? `Validation failed: ${issueMsg}` : 'Validation failed',
      issues: error.validation
    });
    return;
  }
  
  const statusCode = error.statusCode || 500;
  server.log.error({ err: error });
  reply.status(statusCode).send({
    error: statusCode === 500 ? 'Internal Server Error' : error.name || 'Error',
    message: statusCode === 500 ? 'An internal server error occurred' : error.message || 'An unexpected error occurred',
  });
});

server.get('/health', async (_request, _reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

server.get('/favicon.ico', async (_request, reply) => {
  return reply.status(204).send();
});

// Register routes
server.register(ingestRoute);
server.register(contentsRoute);
server.register(suggestionsRoute);
server.register(projectsRoute);
server.register(settingsRoute);
server.register(systemRoute);
server.register(libraryRoute);

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
    const vaultPath = process.env.VAULT_PATH || env.VAULT_PATH;
    if (vaultPath) {
      startVaultWatcher(vaultPath).catch(err => {
        server.log.error({ err }, 'Vault Watcher Error:');
      });
    } else {
      server.log.warn('VAULT_PATH is not set. Skipping Obsidian Sync Watcher.');
    }

    const host = env.HOST;
    const port = env.PORT;
    await server.listen({ port, host });
    console.log(`Server listening on http://${host}:${port}`);

    // Graceful shutdown handlers
    let isShuttingDown = false;
    const handleShutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      await stopServer();
      process.exit(0);
    };

    process.once('SIGINT', () => handleShutdown('SIGINT'));
    process.once('SIGTERM', () => handleShutdown('SIGTERM'));
  } catch (err) {
    server.log.error({ err });
    process.exit(1);
  }
};

export const stopServer = async () => {
  try {
    server.log.info('Shutting down server gracefully...');
    await stopVaultWatcher();
    try { await boss.stop(); } catch { /* ignore boss stop errors */ }
    try { await server.close(); } catch { /* ignore server close errors */ }
    try { await pool.end(); } catch { /* ignore pool end errors */ }
    server.log.info('Server shutdown complete');
  } catch (err) {
    server.log.error({ err }, 'Error during shutdown');
  }
};

if (require.main === module) {
  startServer();
}
