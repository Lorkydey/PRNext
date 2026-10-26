import { packageManifest, nativePlatform, resolveNativeBinary } from './resolve.mjs';

// The package's Node engines use explicit minimum versions and major ranges.
// Keep this check local: a diagnostic must never fetch package metadata.
export function supportedNode(version, range = packageManifest.engines.node) {
  const parsed = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(version);
  if (!parsed) return false;
  const actual = parsed.slice(1).map(Number);
  return range.split('||').some(part => {
    const match = /^\s*(\^|>=)(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    if (!match) return false;
    const minimum = match.slice(2).map(Number);
    const compared = actual[0] - minimum[0] || actual[1] - minimum[1] || actual[2] - minimum[2];
    return compared >= 0 && (match[1] !== '^' || actual[0] === minimum[0]);
  });
}

/** Inspect installation metadata and executable access; never execute or build it. */
export async function environmentDiagnostics({ version = process.version, platform = process.platform, arch = process.arch,
  libc, env = process.env, resolve = resolveNativeBinary } = {}) {
  const diagnostics = [];
  diagnostics.push(supportedNode(version)
    ? { id: 'node', severity: 'info', message: `Node ${version} satisfies ${packageManifest.engines.node}.` }
    : { id: 'node', severity: 'error', message: `Node ${version} is unsupported.`, action: `Use Node ${packageManifest.engines.node}.` });
  try {
    const target = env.PRNEXT_BINARY ? null : nativePlatform({ platform, arch, libc });
    await resolve({ env, allowBuild: false, platform: { platform, arch, libc } });
    diagnostics.push({ id: 'native', severity: 'info', message: `Native executable is accessible for ${platform}/${arch}${target?.libc ? `/${target.libc}` : ''}; metadata/access checked without running it.`, ...(target ? { package: target.package } : { override: true }) });
  } catch (error) {
    diagnostics.push({ id: 'native', severity: 'error', message: error.message,
      action: 'Install matching PRNext optional dependencies on this machine. For a source checkout, build the native server explicitly; check never builds it.' });
  }
  return diagnostics;
}
