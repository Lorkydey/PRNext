// Source sync protocol v1. Kept byte-identical to the npm CLI copy.
export const SOURCE_PROTOCOL = 1;
export const SOURCE_CHUNK_BYTES = 1024 * 1024;
export const SOURCE_READ_BYTES = 256 * 1024;
export const sourceExcluded = (name) =>
  /^(?:node_modules|\.git|\.hg|\.svn|\.next|\.local|\.npm|\.ssh|\.aws|\.azure|\.vercel|coverage|dist|out|__MACOSX|\.DS_Store)$/i.test(
    name
  ) ||
  /^\.prnext(?:[.-]|$)/i.test(name) ||
  /^\.env(?:\.|$)/i.test(name) ||
  /^(?:\.npmrc|\.yarnrc\.yml|\.netrc|\.pypirc|credentials\.json|id_rsa|id_ed25519)$/i.test(
    name
  ) ||
  /\.(?:pem|key|p12|pfx|log|tsbuildinfo)$/i.test(name);
export function sourcePath(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    !value ||
    value.length > 512 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    /[\\:\x00-\x1f\x7f*?"<>|]/.test(value)
  )
    throw Error('Unsafe source path.');
  const parts = value.split('/');
  if (
    parts.length > 32 ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p.length > 255 ||
        /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    )
  )
    throw Error('Unsafe source path.');
  if (parts.some(sourceExcluded))
    throw Error(
      'Secrets, credentials, dependencies and build output are excluded from source sync.'
    );
  return value;
}
export function validateSourcePaths(paths) {
  const set = new Set();
  for (const path of paths) {
    sourcePath(path);
    const key = path.toLowerCase();
    if (set.has(key))
      throw Error('Source paths must be unique on all supported systems.');
    set.add(key);
  }
  for (const key of set) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++)
      if (set.has(parts.slice(0, i).join('/')))
        throw Error('A source file cannot also be a directory.');
  }
}
