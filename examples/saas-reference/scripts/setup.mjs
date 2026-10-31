import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../lib/auth.js';
import { getPool } from '../lib/database.js';

try {
  const migrations = await getMigrations(getAuth().options);
  await migrations.runMigrations();
  await getPool().query('CREATE TABLE IF NOT EXISTS prnext_reference_notes (id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500), created_at timestamptz NOT NULL DEFAULT now())');
  console.log('Reference database is ready.');
} catch {
  console.error('Database setup failed. Check DATABASE_URL, credentials and migration permissions.');
  process.exitCode = 1;
} finally { await getPool().end(); }
