import assert from 'node:assert/strict';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { saveNoteIdempotently } from '../../examples/saas-reference/lib/note-commands.js';
import { replayReferenceAction } from './security-scenarios.mjs';
import { assertSuccessfulActionBody } from './action-response.mjs';

export function rewriteNoteAction(action, { key, nextKey, body, nextBody }) {
  let bytes = action.body;
  for (const [before, after] of [[key,nextKey],[body,nextBody]]) {
    assert.equal(typeof before,'string');assert.ok(before.length>0);
    const needle=Buffer.from(before),at=bytes.indexOf(needle);
    assert.ok(at>=0 && bytes.indexOf(needle,at+needle.length)===-1,'Expected one exact bounded fixture form value.');
    bytes=Buffer.concat([bytes.subarray(0,at),Buffer.from(after),bytes.subarray(at+needle.length)]);
  }
  return { ...action, body:bytes };
}

// The one deliberately interrupted HTTP call is loopback-only and uses this
// fixture's public test certificate. TLS verification is never changed globally.
export function discardActionResponse(action, { beforeDiscard = async () => {} } = {}) {
  const url=new URL(action.url);
  if(url.protocol!=='https:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw new Error('Fault injection requires the owned HTTPS loopback fixture.');
  const headers={};
  for(const name of ['next-action','content-type','rsc','accept','x-prnext-router-state','cookie','origin'])if(action.headers[name])headers[name]=action.headers[name];
  headers['content-length']=String(action.body.length);
  return new Promise((resolve,reject)=>{
    let received=false;
    const outgoing=request(url,{method:'POST',headers,rejectUnauthorized:false},response=>{
      received=true;
      const result={status:response.statusCode,contentType:response.headers['content-type']};
      void Promise.resolve().then(beforeDiscard).then(()=>{
        response.destroy();outgoing.destroy();resolve(result);
      },error=>{response.destroy();outgoing.destroy();reject(error);});
    });
    outgoing.setTimeout(15000,()=>outgoing.destroy(new Error('The interrupted reference mutation exceeded its deadline.')));
    outgoing.on('error',error=>{if(!received)reject(error);});
    outgoing.end(action.body);
  });
}

export async function qualifyIdempotentMutations({ context, fixture, pool, action, key, body, email, proof }) {
  const userId=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id;
  const other=await fixture.pool({max:4});
  const marker='IDEMPOTENT_'+randomUUID(),commandKey=randomUUID();
  try {
    const replies=await Promise.all(Array.from({length:16},(_,index)=>saveNoteIdempotently(index%2?pool:other,{userId,key:commandKey,body:marker})));
    assert.equal(new Set(replies.map(value=>value.id)).size,1);
    assert.equal(replies.filter(value=>!value.replayed).length,1);
    assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,marker])).rows[0].count,'1');
    await assert.rejects(saveNoteIdempotently(pool,{userId,key:commandKey,body:marker+'_changed'}),error=>error.code==='IDEMPOTENCY_CONFLICT');
    await pool.query('DELETE FROM prnext_reference_notes WHERE id=$1',[replies[0].id]);
    assert.equal((await saveNoteIdempotently(other,{userId,key:commandKey,body:marker})).id,replies[0].id);
    assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE id=$1',[replies[0].id])).rows[0].count,'0','A deleted note must not be resurrected by replay.');
    proof.concurrent={attempts:replies.length,writes:1,differentPayloadRejected:true,deletedResultNotRecreated:true};
  } finally { await other.end(); }

  const lostKey=randomUUID(),lostBody='LOST_RESPONSE_'+randomUUID();
  const interrupted=rewriteNoteAction(action,{key,nextKey:lostKey,body,nextBody:lostBody});
  const discarded=await discardActionResponse(interrupted,{beforeDiscard:async()=>{
    // Prove COMMIT before discarding the response, even if a future transport
    // begins streaming its HTTP headers before the action has completed.
    for(let attempt=0;;attempt++){
      const count=(await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,lostBody])).rows[0].count;
      if(count==='1')break;
      assert.ok(attempt<30,'The lost-response write must commit before interruption.');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }});
  assert.equal(discarded.status,200);assert.match(discarded.contentType,/^text\/x-component/);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,lostBody])).rows[0].count,'1');
  const retry=await replayReferenceAction(context,interrupted);
  assert.equal(retry.status(),200);const retryBody=await retry.body();assertSuccessfulActionBody(retryBody);
  assert.match(retryBody.toString(),/"replayed":true/);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,lostBody])).rows[0].count,'1');
  proof.lostResponse={responseDiscardedAfterHeaders:true,commitVerifiedBeforeDiscard:true,committedBeforeExplicitRetry:true,explicitRetries:1,writes:1};

  // A real database-side failure after claiming the key must roll back BOTH
  // the claim and the note. All objects belong to the disposable test schema.
  const failedKey=randomUUID(),failedBody='INJECT_TRANSACTION_FAILURE';
  await pool.query(`CREATE FUNCTION prnext_reference_fail_note() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.body = 'INJECT_TRANSACTION_FAILURE' THEN RAISE EXCEPTION 'injected note failure'; END IF; RETURN NEW; END$$`);
  try {
    await pool.query('CREATE TRIGGER prnext_reference_fail_note BEFORE INSERT ON prnext_reference_notes FOR EACH ROW EXECUTE FUNCTION prnext_reference_fail_note()');
    await assert.rejects(saveNoteIdempotently(pool,{userId,key:failedKey,body:failedBody}));
    assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_note_commands WHERE user_id=$1 AND request_key=$2',[userId,failedKey])).rows[0].count,'0');
  } finally { await pool.query('DROP TRIGGER IF EXISTS prnext_reference_fail_note ON prnext_reference_notes');await pool.query('DROP FUNCTION prnext_reference_fail_note()'); }
  assert.equal((await saveNoteIdempotently(pool,{userId,key:failedKey,body:failedBody})).replayed,false);
  proof.rollback={failedClaimRolledBack:true,explicitRetrySucceeded:true};

  const outageKey=randomUUID(),outageBody='DATABASE_OUTAGE_'+randomUUID();
  const unavailable=rewriteNoteAction(action,{key,nextKey:outageKey,body,nextBody:outageBody});
  let idleErrors=0;
  const observed=()=>{idleErrors++;};pool.on('error',observed);
  try {
    await fixture.faults.pausePostgres();
    const response=await replayReferenceAction(context,unavailable);
    const failed=await response.body();
    assert.ok(response.status()>=400||/"error"|\bE\{/.test(failed.toString()),'An unavailable database cannot acknowledge a saved mutation.');
  } finally { await fixture.faults.resumePostgres();pool.off('error',observed); }
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,outageBody])).rows[0].count,'0');
  const recovered=await replayReferenceAction(context,unavailable);
  assert.equal(recovered.status(),200);assertSuccessfulActionBody(await recovered.body());
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1 AND body=$2',[userId,outageBody])).rows[0].count,'1');
  proof.postgresOutage={realClusterStopped:true,idleConnectionErrorsObserved:idleErrors,writesWhileUnavailable:0,recoveredWrites:1};
}
