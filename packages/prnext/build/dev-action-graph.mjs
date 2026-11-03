import path from 'node:path';

// Build-private provenance, never Action arguments, source text or encryption
// material. Unknown/external owners deliberately disable selective refresh.
export function developmentActionMetadata(root, actions) {
  const records = [], identities = new Set(); let bytes = 0;
  for (const action of actions) {
    const file = path.relative(root, action.file).replaceAll(path.sep, '/');
    const runtimes = [...(action.runtimes?.size ? action.runtimes : ['nodejs'])].sort();
    const record = { id: action.id, file, binding: action.binding, runtimes };
    const identity = file + '\0' + action.binding;
    if (!/^[a-f0-9]{64}$/.test(action.id) || !file || file.startsWith('../') || path.isAbsolute(file) || /[:?\0]/.test(file) || file.startsWith('node_modules/') ||
        typeof action.binding !== 'string' || !action.binding || action.binding.length > 1024 || identities.has(identity) ||
        runtimes.some(runtime => !['nodejs', 'edge'].includes(runtime)) || records.length >= 10000 ||
        (bytes += Buffer.byteLength(JSON.stringify(record))) > 1024 * 1024)
      return { version: 1, complete: false, actions: [] };
    identities.add(identity); records.push(record);
  }
  records.sort((a, b) => a.file.localeCompare(b.file) || a.binding.localeCompare(b.binding));
  return { version: 1, complete: true, actions: records };
}
