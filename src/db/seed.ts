import { db } from './index';
import { projects } from './schema';
import dotenv from 'dotenv';

dotenv.config();

async function seedDb() {
  console.log('Seeding database...');
  
  await db.insert(projects).values([
    {
      folderPath: 'Projects/TestProject',
      title: 'Test Project',
      currentHash: 'dummy_hash_123',
    }
  ]).onConflictDoNothing();
  
  console.log('Seed complete.');
  process.exit(0);
}

seedDb().catch((err) => {
  console.error('Seed failed!', err);
  process.exit(1);
});
