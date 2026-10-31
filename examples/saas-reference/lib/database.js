import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { required } from './environment.js';
import { threadId } from 'node:worker_threads';

export const notes = pgTable('prnext_reference_notes', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

let pool;
export function getPool() {
  if (!pool) {
    const connectionString = required('DATABASE_URL');
    let parsed;
    try { parsed = new URL(connectionString); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL.'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
    pool = new pg.Pool({ connectionString, application_name: 'prnext-saas-reference:' + process.pid + ':' + threadId, max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000, query_timeout: 5000 });
    pool.on('error', () => console.error('The reference database connection is unavailable.'));
  }
  return pool;
}
export const getDatabase = () => drizzle(getPool());
