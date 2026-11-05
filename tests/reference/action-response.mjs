// This qualification uses the pinned React production Flight protocol. Fail
// closed if its root model changes; never treat an unknown body as success.
function actionRoot(bytes) {
  if (!bytes?.length || bytes.length > 16 * 1024 ** 2) throw new Error('The Server Action response body is empty or exceeds its limit.');
  const text = Buffer.from(bytes).toString('utf8');
  const line = text.split('\n').find(value => value.startsWith('0:'));
  let model;
  try { model = JSON.parse(line?.slice(2)); } catch { throw new Error('The Server Action response has no recognized root model.'); }
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('The Server Action response has no recognized root model.');
  return { model, text };
}

export function assertSuccessfulActionBody(bytes) {
  const { model, text } = actionRoot(bytes);
  const absent = value => value === undefined || value === null || value === '$undefined';
  if (!absent(model.actionError) || !absent(model.actionRedirect) || /(?:^|\n)[0-9a-f]+:E/.test(text)) throw new Error('The Server Action response contains an error or unexpected redirect.');
  if (!Object.hasOwn(model, 'tree') && !Object.hasOwn(model, 'actionResult')) throw new Error('The Server Action response has no outcome.');
  return model;
}

export function assertRevokedActionResponse({ status, headers = {}, body, origin, signInPath }) {
  const redirect = destination => {
    let url;
    try { url = new URL(destination, origin); } catch { throw new Error('The revoked mutation has no valid sign-in redirect.'); }
    if (url.origin !== origin || url.pathname !== signInPath) throw new Error('The revoked mutation redirected outside its sign-in page.');
  };
  if (status === 303 || status === 307) { redirect(headers.location); return; }
  if (status !== 200) throw new Error('The revoked mutation has no recognized authentication denial.');
  const { model, text } = actionRoot(body);
  if (![undefined, null, '$undefined'].includes(model.actionError) || /(?:^|\n)[0-9a-f]+:E/.test(text)) throw new Error('The revoked mutation contains a rendering failure instead of an authentication denial.');
  if (model.actionRedirect && typeof model.actionRedirect === 'object') {
    redirect(model.actionRedirect.url); return;
  }
  assertSuccessfulActionBody(body);
  if (!model.actionResult || typeof model.actionResult !== 'object' || model.actionResult.error !== 'authentication' || model.actionResult.saved === true) {
    throw new Error('The revoked mutation did not explicitly reject authentication.');
  }
}
