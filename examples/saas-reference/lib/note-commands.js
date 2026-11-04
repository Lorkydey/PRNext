import { createHash, randomUUID } from 'node:crypto';

export const noteCommandSchema = `CREATE TABLE IF NOT EXISTS prnext_reference_note_commands (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  note_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_key)
)`;

// A command survives deletion of its note: replaying a confirmed old request
// must not recreate a note that its owner has since deliberately deleted.
// Retention/archival is an application policy; expiring a key ends its replay
// guarantee and must never happen silently inside a request retry.
export async function saveNoteIdempotently(pool, { userId, key, body }) {
  if (typeof userId !== 'string' || !userId || userId.length > 128
      || typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)
      || typeof body !== 'string' || !body || body.length > 500 || body !== body.trim()) {
    throw Object.assign(new Error('A note command requires a bounded owner, request key and note.'), { code:'IDEMPOTENCY_INPUT' });
  }
  const digest = createHash('sha256').update(body).digest('hex');
  const client = await pool.connect();
  let transaction = false, discard = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '5s'");
    const id = randomUUID();
    const claimed = await client.query(`INSERT INTO prnext_reference_note_commands (user_id,request_key,payload_hash,note_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,request_key) DO NOTHING RETURNING note_id`, [userId,key,digest,id]);
    let noteId = id;
    const replayed = !claimed.rowCount;
    if (replayed) {
      // A concurrent INSERT conflict waits for its transaction. This separate
      // READ COMMITTED statement then sees the committed winner's result.
      const previous = await client.query('SELECT payload_hash,note_id FROM prnext_reference_note_commands WHERE user_id=$1 AND request_key=$2', [userId,key]);
      if (previous.rows[0]?.payload_hash !== digest) throw Object.assign(new Error('This request key already belongs to another note.'), { code:'IDEMPOTENCY_CONFLICT' });
      noteId = previous.rows[0].note_id;
    } else await client.query('INSERT INTO prnext_reference_notes (id,user_id,body) VALUES ($1,$2,$3)', [id,userId,body]);
    await client.query('COMMIT'); transaction = false;
    return { id:noteId, replayed };
  } catch (error) {
    // COMMIT can succeed before a connection is lost. Do not repeat it here:
    // only an explicit caller retry with the original key resolves ambiguity.
    if (transaction) try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
