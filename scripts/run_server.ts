import 'dotenv/config';
import { startServer } from '../src/api/server';
import { demoVaultPath } from '../src/vault/demo';

// Without VAULT_PATH, use the demo vault in the notes language (demo_vault or demo_vault_en)
process.env.VAULT_PATH = process.env.VAULT_PATH || demoVaultPath();
process.env.PORT = process.env.PORT || '3000';

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
