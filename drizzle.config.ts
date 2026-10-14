import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://loom:loompassword@localhost:5432/loomdb',
  },
  schemaFilter: ['public'], // Ignorar otros esquemas como el de pg-boss
});
