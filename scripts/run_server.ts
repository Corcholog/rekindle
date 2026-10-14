import 'dotenv/config';
import { startServer } from '../src/api/server';
import * as path from 'path';

// If no VAULT_PATH in .env or environment, default to demo_vault
process.env.VAULT_PATH = process.env.VAULT_PATH || path.resolve(process.cwd(), 'demo_vault');
process.env.PORT = process.env.PORT || '3000';

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
