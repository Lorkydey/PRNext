// This qualification uses the pinned React production Flight protocol. Fail
// closed if its root model changes; never treat an unknown body as success.
export function assertSuccessfulActionBody(bytes) {
  if (!bytes?.length || bytes.length > 16 * 1024 ** 2) throw new Error('The Server Action response body is empty or exceeds its limit.');
  const text = Buffer.from(bytes).toString('utf8');
  const line = text.split('\n').find(value => value.startsWith('0:'));
  let model;
  try { model = JSON.parse(line?.slice(2)); } catch { throw new Error('The Server Action response has no recognized root model.'); }
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('The Server Action response has no recognized root model.');
  const absent = value => value === undefined || value === null || value === '$undefined';
  if (!absent(model.actionError) || !absent(model.actionRedirect) || /(?:^|\n)[0-9a-f]+:E/.test(text)) throw new Error('The Server Action response contains an error or unexpected redirect.');
  if (!Object.hasOwn(model, 'tree') && !Object.hasOwn(model, 'actionResult')) throw new Error('The Server Action response has no outcome.');
}
