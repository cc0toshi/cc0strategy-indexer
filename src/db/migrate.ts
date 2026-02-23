import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../migrations');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const sql = postgres(DATABASE_URL);

async function migrate() {
  console.log('Running migrations...');
  await sql`CREATE TABLE IF NOT EXISTS _migrations (name VARCHAR(255) PRIMARY KEY, run_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`;
  
  const ran = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
  const ranNames = new Set(ran.map(r => r.name));
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    if (ranNames.has(file)) { console.log(`⏭️  Skipping ${file}`); continue; }
    console.log(`🔄 Running ${file}...`);
    try {
      await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf-8'));
      await sql`INSERT INTO _migrations (name) VALUES (${file})`;
      console.log(`✅ ${file} completed`);
    } catch (error) { console.error(`❌ Error in ${file}:`, error); process.exit(1); }
  }
  console.log('✅ All migrations complete');
  await sql.end();
}

migrate().catch(console.error);
