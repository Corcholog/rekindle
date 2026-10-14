import { defineConfig } from 'drizzle-kit';
import { env } from './src/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  schemaFilter: ['public'], // Ignorar otros esquemas como el de pg-boss
});
