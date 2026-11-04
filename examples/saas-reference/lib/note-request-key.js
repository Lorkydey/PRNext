const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function storageName(owner, locale) {
  if (typeof owner !== 'string' || !owner || owner.length > 128 || !['fr','en'].includes(locale)) throw new Error('Invalid note request scope.');
  return 'prnext-reference:note-request:' + JSON.stringify([owner,locale]);
}

export function noteRequestKey(storage, owner, locale, { rotate = false, generate = () => crypto.randomUUID() } = {}) {
  const name = storageName(owner,locale), previous = storage.getItem(name);
  if (!rotate && uuid(previous)) return previous;
  const next = generate();
  if (!uuid(next)) throw new Error('A note request requires a UUID.');
  storage.setItem(name,next);
  if (storage.getItem(name) !== next) throw new Error('The pending note request could not be retained.');
  return next;
}
