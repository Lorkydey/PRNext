import assert from 'node:assert/strict';

const url = process.argv[2];
// Keep the survivor and every observed shell within memory's 28 live-response
// budget. Use an explicit larger count for speed; 32 + a survivor exceeds
// balanced's 32 slots and would test the harness deadline rather than cancellation.
const cancellations = Number(process.argv[3] || 16);
assert.ok(Number.isInteger(cancellations) && cancellations > 0 && cancellations < 128);
const pid = async () => { const response = await fetch(url + '/api/json'); await response.arrayBuffer(); return response.headers.get('x-worker-pid'); };
const initialWorker = await pid();
async function shell(ms) {
  const response = await fetch(url + '/stream?delay=' + ms, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let prefix = '';
  while (!prefix.includes('pending-stream')) {
    const { value, done } = await reader.read();
    assert.ok(!done, 'response must expose a progressive fallback');
    prefix += Buffer.from(value).toString();
  }
  assert.ok(!prefix.includes('completed:anonymous:'), 'response must still be active');
  return reader;
}

const survivor = await shell(4000);
let survivorSettled = false;
const survivorCompletion = (async () => {
  let tail = '';
  for (;;) {
    const { value, done } = await survivor.read();
    if (done) break;
    tail += Buffer.from(value).toString();
  }
  return tail;
})().finally(() => { survivorSettled = true; });
// Attach a rejection observer immediately, including while preparing the burst.
survivorCompletion.catch(() => {});
const abandoned = await Promise.all(Array.from({ length: cancellations }, () => shell(8000)));
assert.equal(survivorSettled, false, 'survivor must remain active before simultaneous cancellation');
await Promise.all(abandoned.map(reader => reader.cancel()));
assert.equal(survivorSettled, false, 'survivor must remain active through simultaneous cancellation');
const tail = await survivorCompletion;
assert.ok(tail.includes('completed:anonymous:'), 'unrelated active render must complete after the cancellation burst');
const workerAfter = await pid();
assert.equal(workerAfter, initialWorker, 'normal cancellation must not restart the Node host');
const healthy = await fetch(url + '/ssr');
assert.equal(healthy.status, 200);
assert.ok((await healthy.text()).includes('nonce:'));
console.log(JSON.stringify({ cancellations, survivorCompleted: true, subsequentSsrHealthy: true, workerBefore: initialWorker, workerAfter, sameWorker: true }));
