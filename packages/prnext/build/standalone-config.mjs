import path from 'node:path';

export function validateStandaloneConfig(config) {
  if (config.output !== undefined && !['standalone', 'export'].includes(config.output)) throw new Error('output supports "standalone" or "export".');
  if (config.outputFileTracingRoot !== undefined && (typeof config.outputFileTracingRoot !== 'string' || !path.isAbsolute(config.outputFileTracingRoot) || config.outputFileTracingRoot.includes('\0') || config.outputFileTracingRoot.length > 4096)) throw new Error('outputFileTracingRoot must be an absolute directory path.');
  for (const key of ['outputFileTracingIncludes', 'outputFileTracingExcludes']) {
    const rules = config[key];
    if (rules === undefined) continue;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length > 256) throw new Error(`${key} must map at most 256 route globs to arrays of file globs.`);
    let count = 0;
    for (const [route, patterns] of Object.entries(rules)) {
      if (!route.startsWith('/') || route.length > 4096 || route.includes('\0') || !Array.isArray(patterns)) throw new Error(`${key} must map URL route globs to arrays of relative file globs.`);
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || !pattern || pattern.length > 4096 || path.isAbsolute(pattern) || /[\0\\]/.test(pattern) || pattern.startsWith('!') || ++count > 1024) throw new Error(`${key} file globs must be relative paths; at most 1024 patterns are supported.`);
      }
    }
  }
  return config;
}
