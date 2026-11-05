import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '@playwright/test';
import { referenceDeadline } from './lifecycle.mjs';

// Injected only into a fresh disposable consumer through extraFiles. Neither
// the published framework nor the public SaaS example contains this endpoint.
export const workerProofRoute = `import{getAuth}from'../../../lib/auth.js';
import{getPool}from'../../../lib/database.js';
export const dynamic='force-dynamic';
export async function GET(request){
const session=await getAuth().api.getSession({headers:request.headers});
if(!session)return Response.json({error:'authentication'},{status:401,headers:{'cache-control':'private, no-store'}});
const result=await getPool().query('SELECT /* prnext-reference-worker-proof */ body FROM prnext_reference_notes WHERE user_id=$1 ORDER BY id',[session.user.id]);
return Response.json({pid:process.pid,userId:session.user.id,notes:result.rows.map(row=>row.body)},{headers:{'cache-control':'private, no-store'}});
}`;

const noteDigest = body => createHash('sha256').update(body).digest('hex');
const route = '/api/reference-worker-proof';
const blockedQuery = `SELECT activity.pid AS backend_pid,activity.application_name
FROM pg_stat_activity AS activity
WHERE activity.datname=current_database()
AND activity.application_name LIKE 'prnext-saas-reference:%'
AND activity.wait_event_type='Lock'
AND activity.query LIKE 'SELECT /* prnext-reference-worker-proof */%'
AND $1::int=ANY(pg_blocking_pids(activity.pid))
ORDER BY activity.pid`;

export function assertWorkerAttribution(blocked, results, accounts, serverPid) {
  assert.equal(blocked.length, 2, 'Exactly two authenticated note queries must be held by this controller.');
  const blockedPids = new Set(blocked.map(row => {
    const match = /^prnext-saas-reference:([1-9]\d*):\d+$/.exec(row.application_name);
    assert.ok(match, 'A blocked query must identify an application worker.');
    return Number(match[1]);
  }));
  assert.equal(blockedPids.size, 2, 'Both requests must overlap on two distinct Node processes.');
  assert.equal(results.length, 2);
  for (let index = 0; index < results.length; index++) {
    const value = results[index], owner = accounts[index], other = accounts[1 - index];
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid !== process.pid && value.pid !== serverPid);
    assert.equal(value.userId, owner.userId, 'The worker must authenticate the request owner.');
    assert.deepEqual(value.notes, [owner.note], 'The worker may return only the authenticated owner’s dedicated note.');
    assert.ok(!value.notes.includes(other.note));
  }
  const responsePids = new Set(results.map(value => value.pid));
  assert.equal(responsePids.size, 2, 'Two different worker responses are required.');
  assert.deepEqual([...responsePids].sort((a, b) => a - b), [...blockedPids].sort((a, b) => a - b), 'Response identities must match the actual blocked SQL backends.');
  return [...responsePids].sort((a, b) => a - b);
}

// Invoke only on a fresh server, before browser pages or concurrent traffic.
// Sequential API sign-ups fully consume their responses and do not introduce
// a setup burst. The actual two-process overlap is proved by the owned SQL
// lock and matching responses below, rather than inferred from scheduling.
export async function proveReferenceWorkers({ fixture, acquire, proof, Pool, accounts: previousAccounts }) {
  Object.assign(proof, { version: 1, complete: false, fixtureRouteSha256: noteDigest(workerProofRoute), freshServerRequired: true, httpRetries: 0, barrierBudgetMs: 4000, cleanup: [] });
  let ownPool, controller, observer, transaction = false, phase = 'acquire', failure;
  const contexts = [], pending = [], accounts = [];
  const close = async (resource, operation, timeout = 5000) => {
    try { await referenceDeadline(Promise.resolve().then(operation), 'Worker proof resource cleanup exceeded its deadline.', timeout); proof.cleanup.push({ resource, phase: 'closed' }); }
    catch { proof.cleanup.push({ resource, phase: 'cleanup-failed' }); }
  };
  try {
    assert.equal(typeof Pool, 'function', 'The already loaded PostgreSQL pool constructor is required.');
    // The standalone deliberately removes its original node_modules. Reuse
    // the loaded constructor, never a module resolution through that source.
    ownPool = await acquire(() => new Pool({ connectionString: fixture.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 }), value => value.end());
    controller = await acquire(() => ownPool.connect(), value => value.release(true));
    observer = await acquire(() => ownPool.connect(), value => value.release(true));
    for (let index = 0; index < 2; index++) {
      const context = await acquire(() => request.newContext({ ignoreHTTPSErrors: true, ...(previousAccounts ? { storageState: previousAccounts[index].storageState } : {}) }), value => value.dispose());
      contexts.push(context);
      if (previousAccounts) { accounts.push(previousAccounts[index]); continue; }
      phase = 'sequential-real-authentication';
      const response = await context.post(fixture.origin + '/api/auth/sign-up/email', {
        headers: { origin: fixture.origin }, data: { name: 'Worker proof ' + index, email: 'worker-proof-' + randomUUID() + '@example.test', password: 'Worker-proof-' + randomUUID() }, timeout: 15000,
      });
      assert.equal(response.status(), 200, 'Dedicated worker account registration must succeed.');
      const value = await response.json();
      assert.equal(typeof value.user?.id, 'string');
      const account = { userId: value.user.id, note: 'WORKER_PRIVATE_NOTE_' + randomUUID(), storageState: await context.storageState() };
      await observer.query('INSERT INTO prnext_reference_notes(id,user_id,body) VALUES($1,$2,$3)', [randomUUID(), account.userId, account.note]);
      accounts.push(account);
    }
    assert.notEqual(accounts[0].userId, accounts[1].userId);
    const anonymous = await acquire(() => request.newContext({ ignoreHTTPSErrors: true }), value => value.dispose()); contexts.push(anonymous);
    phase = 'owned-sql-lock';
    await controller.query('BEGIN'); transaction = true;
    await controller.query("SET LOCAL lock_timeout = '1000ms'");
    await controller.query('LOCK TABLE prnext_reference_notes IN ACCESS EXCLUSIVE MODE');
    const controllerPid = (await controller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // If the route reads private notes before authenticating, this deliberately
    // held table lock prevents the negative request from returning a 401.
    phase = 'unauthenticated-request-before-private-sql';
    const denied = await anonymous.get(fixture.origin + route, { maxRedirects: 0, timeout: 15000 });
    assert.equal(denied.status(), 401); assert.deepEqual(await denied.json(), { error: 'authentication' });
    assert.equal((await observer.query(blockedQuery, [controllerPid])).rowCount, 0);
    proof.negativeControl = { status: 401, privateTableLocked: true, blockedPrivateQueries: 0, complete: true };
    phase = 'two-overlapping-authenticated-queries';
    const settled = [];
    for (let index = 0; index < 2; index++) {
      const response = contexts[index].get(fixture.origin + route, { maxRedirects: 0, timeout: 15000 });
      pending.push(response); response.then(() => { settled[index] = true; }, () => { settled[index] = true; });
    }
    const started = performance.now(), expires = started + proof.barrierBudgetMs;
    let blocked = [];
    while (performance.now() < expires) {
      assert.ok(!settled.some(Boolean), 'An authenticated proof request ended before the private SQL rendez-vous.');
      blocked = (await observer.query(blockedQuery, [controllerPid])).rows;
      const pids = new Set(blocked.map(row => /^prnext-saas-reference:([1-9]\d*):\d+$/.exec(row.application_name)?.[1]).filter(Boolean));
      if (blocked.length === 2 && pids.size === 2) break;
      // Observe the real lock state, without retrying any HTTP work or assuming
      // that a fixed delay makes unrelated fast requests overlap.
      await delay(20);
    }
    proof.barrier = { controllerBackendPid: controllerPid, heldMs: performance.now() - started, blocked: blocked.map(row => ({ backendPid: row.backend_pid, applicationName: row.application_name })) };
    assert.ok(proof.barrier.heldMs < 4000, 'Both worker queries must overlap before the application query timeout.');
    assert.equal(blocked.length, 2); assert.equal(new Set(blocked.map(row => row.application_name.split(':')[1])).size, 2);
    await controller.query('ROLLBACK'); transaction = false;
    phase = 'authenticated-response-attribution';
    const responses = await referenceDeadline(Promise.all(pending), 'Worker proof responses exceeded their deadline.', 15000), values = [];
    for (const response of responses) { assert.equal(response.status(), 200); assert.match(response.headers()['cache-control'], /private.*no-store/); values.push(await response.json()); }
    const pids = assertWorkerAttribution(blocked, values, accounts, fixture.serverPid);
    proof.processesObserved = pids.length; proof.pids = pids;
    proof.responses = values.map((value, index) => ({ pid: value.pid, userId: value.userId, ownedNoteSha256: noteDigest(accounts[index].note), otherOwnerNoteAbsent: true }));
    phase = 'complete';
  } catch (error) { failure = error; proof.failure = { name: error.name, phase, ...(/^[A-Z0-9_]{1,64}$/.test(error.code || '') ? { code: error.code } : {}) }; }
  finally {
    if (transaction && controller) await close('controller-rollback', async () => { await controller.query('ROLLBACK'); transaction = false; });
    if (pending.length) await close('http-requests', () => Promise.allSettled(pending), 15000);
    for (let index = 0; index < contexts.length; index++) await close('request-context-' + index, () => contexts[index].dispose());
    if (observer) await close('observer-client', () => observer.release(true));
    if (controller) await close('controller-client', () => controller.release(true));
    if (ownPool) await close('proof-pool', () => ownPool.end());
  }
  assert.ok(proof.cleanup.every(row => row.phase === 'closed'), 'Every worker proof resource must close.');
  if (failure) throw new Error('Reference worker proof failed during ' + phase + '.');
  proof.complete = true;
  // Contains HttpOnly session cookies. Return only to the in-memory caller for
  // the fresh standalone phase; never attach these accounts to report JSON.
  return accounts;
}
