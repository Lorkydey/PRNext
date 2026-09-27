import { build as bundle } from 'esbuild';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvConfig } from '../runtime/env.mjs';
import constants from '../compat/constants.cjs';
import cacheProfiles from '../compat/cache-life.cjs';
import { validateDistDir } from '../runtime/build-directory.mjs';
import { validateCacheHandler, validateCacheHandlers } from './cache-handlers.mjs';
import { validateImagesConfig } from './images-config.mjs';
import { pageExtensionPattern, defaultPageExtensions } from './page-extensions.mjs';
import { validateServerActions } from './server-actions-config.mjs';
import { validateStandaloneConfig } from './standalone-config.mjs';
import { validateTurbopack } from './module-resolution.mjs';
import { validateI18n } from './i18n.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configName = /^(?:next|prnext)\.config\.(?:js|mjs|cjs|ts)$/;
const supported = new Set(['env', 'redirects', 'headers', 'rewrites', 'generateBuildId', 'compress', 'poweredByHeader', 'productionBrowserSourceMaps', 'basePath', 'assetPrefix', 'experimental', 'sassOptions', 'transpilePackages', 'serverExternalPackages', 'cacheComponents', 'cacheLife', 'images', 'reactStrictMode', 'pageExtensions', 'trailingSlash', 'skipTrailingSlashRedirect', 'skipMiddlewareUrlNormalize', 'skipProxyUrlNormalize', 'cacheHandlers', 'distDir']);
const defaults = { distDir: '.prnext', env: {}, compress: true, poweredByHeader: true, productionBrowserSourceMaps: false, basePath: '', assetPrefix: '', trailingSlash: false, skipTrailingSlashRedirect: false, skipMiddlewareUrlNormalize: false, experimental: { nextScriptWorkers: false } };
supported.add('cacheHandler');
supported.add('cacheMaxMemorySize');
supported.add('turbopack');
supported.add('i18n');
supported.add('webpack');
supported.add('onDemandEntries');
for (const key of ['output', 'outputFileTracingRoot', 'outputFileTracingIncludes', 'outputFileTracingExcludes']) supported.add(key);

function validPrefixPath(value, where, { root = false } = {}) {
  if (/[^\x00-\x7f]/.test(value)) throw new Error(`${where} must use an ASCII URL pathname; percent-encode non-ASCII characters explicitly.`);
  if ((!root && value === '/') || !value.startsWith('/') || value.startsWith('//') || /[\s\\?#\u0000-\u001f\u007f]/.test(value) ||
      value.replace(/\/+$/, '').split('/').some((segment, index) => index && (!segment || segment === '.' || segment === '..')) || /%(?![\da-f]{2})/i.test(value)) {
    throw new Error(`${where} must be a URL pathname prefix without query, fragment, whitespace, backslashes, empty interior segments or dot segments.`);
  }
}

export function publicAssetBase(config) {
  return (config.assetPrefix || config.basePath || '').replace(/\/+$/, '') + '/_prnext/assets';
}

function configPlugin() {
  return {
    name: 'prnext-project-config',
    setup(build) {
      build.onResolve({ filter: /^(?:next|prnext)\/constants(?:\.js)?$/ }, () => ({ path: path.join(packageRoot, 'compat/constants.cjs') }));
      build.onLoad({ filter: /\.(?:[cm]?js|ts)$/ }, async ({ path: filename }) => {
        if (filename.includes(`${path.sep}node_modules${path.sep}`)) return;
        // Preserve filesystem paths after bundling config's relative helpers.
        const prefix = `const __prnext_config_url=${JSON.stringify(pathToFileURL(filename).href)};const __prnext_config_file=${JSON.stringify(filename)};const __prnext_config_dir=${JSON.stringify(path.dirname(filename))};\n`;
        const source = (await readFile(filename, 'utf8')).replace(/^#![^\n]*(?:\n|$)/, '');
        return { contents: prefix + source, loader: filename.endsWith('.ts') ? 'ts' : 'js', resolveDir: path.dirname(filename) };
      });
    },
  };
}

async function importConfig(filename) {
  const temporary = path.join(path.dirname(filename), `.prnext-config-${randomUUID()}.mjs`);
  try {
    const result = await bundle({ entryPoints: [filename], absWorkingDir: path.dirname(filename), bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'silent',
      define: { 'import.meta.url': '__prnext_config_url', __filename: '__prnext_config_file', __dirname: '__prnext_config_dir' },
      banner: { js: `import {createRequire as __prnext_create_require} from 'node:module';const require=__prnext_create_require(${JSON.stringify(pathToFileURL(filename).href)});` },
      plugins: [configPlugin()],
    });
    await writeFile(temporary, result.outputFiles[0].contents, { flag: 'wx' });
    const imported = await import(pathToFileURL(temporary).href);
    return imported.default;
  } finally { await rm(temporary, { force: true }); }
}

export function validateProjectConfig(input, filename = 'project config') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${filename} must export a configuration object or a function returning one.`);
  for (const key of Object.keys(input)) {
    if (!supported.has(key)) throw new Error(`${filename}: option "${key}" is not supported by PRNext. It cannot be silently ignored.`);
  }
  // Optional properties explicitly set to undefined still use their defaults,
  // as in common process.env-based Next configuration wrappers.
  const config = { ...defaults, ...Object.fromEntries(Object.entries(input).filter(([,value]) => value !== undefined)) };
  if (config.onDemandEntries !== undefined) {
    const entries = config.onDemandEntries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError('onDemandEntries must be an object');
    for (const [key, value] of Object.entries(entries)) {
      if (!['maxInactiveAge', 'pagesBufferLength'].includes(key)) throw new TypeError(`onDemandEntries.${key} is not supported`);
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`onDemandEntries.${key} must be a non-negative safe integer`);
    }
    config.onDemandEntries = { maxInactiveAge: entries.maxInactiveAge ?? 60000, pagesBufferLength: entries.pagesBufferLength ?? 5 };
  }
  if (config.webpack !== undefined && typeof config.webpack !== 'function') throw new TypeError('webpack must be a configuration function');
  config.turbopack = validateTurbopack(config.turbopack);
  config.i18n = validateI18n(config.i18n);
  if (config.i18n && config.output === 'export') throw new Error("i18n and output: 'export' cannot be combined; use explicit locale routes for static exports");
  validateStandaloneConfig(config);
  config.distDir = validateDistDir(config.distDir);
  if (config.output === 'export' && (config.distDir === 'out' || config.distDir.startsWith('out/'))) throw new Error("output: 'export' reserves out/ for exported files; choose a different distDir");
  pageExtensionPattern(config.pageExtensions);
  config.pageExtensions = [...new Set(config.pageExtensions || defaultPageExtensions)];
  if (config.reactStrictMode !== undefined && typeof config.reactStrictMode !== 'boolean') throw new Error(`${filename}: reactStrictMode must be a boolean.`);
  config.cacheComponents ??= false;
  if (typeof config.cacheComponents !== 'boolean') throw new TypeError('cacheComponents must be a boolean');
  config.cacheLife = cacheProfiles.profiles(config.cacheLife);
  for (const key of ['transpilePackages', 'serverExternalPackages']) {
    const names = config[key] ?? [];
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('.') || /^(?:react|react-dom|react-server-dom-webpack|next|prnext)$/.test(name))) throw new Error(`${filename}: ${key} must be an array of npm package names excluding framework and React packages.`);
    config[key] = [...new Set(names)];
  }
  for (const name of config.transpilePackages) if (config.serverExternalPackages.includes(name)) throw new Error(`${filename}: ${name} cannot be in both transpilePackages and serverExternalPackages.`);
  if (config.sassOptions !== undefined && (!config.sassOptions || typeof config.sassOptions !== 'object' || Array.isArray(config.sassOptions))) throw new Error(`${filename}: sassOptions must be an object.`);
  if (!config.experimental || typeof config.experimental !== 'object' || Array.isArray(config.experimental)) throw new Error(`${filename}: experimental must be an object.`);
  for (const key of Object.keys(config.experimental)) {
    if (!['nextScriptWorkers', 'serverActions'].includes(key)) throw new Error(`${filename}: experimental.${key} is not supported by PRNext. It cannot be silently ignored.`);
  }
  const nextScriptWorkers = config.experimental.nextScriptWorkers === undefined ? false : config.experimental.nextScriptWorkers;
  if (typeof nextScriptWorkers !== 'boolean') throw new Error(`${filename}: experimental.nextScriptWorkers must be a boolean.`);
  config.experimental = { nextScriptWorkers, serverActions: validateServerActions(config.experimental.serverActions) };
  for (const key of ['basePath', 'assetPrefix']) {
    if (typeof config[key] !== 'string' || Buffer.byteLength(config[key]) > 4096) throw new Error(`${filename}: ${key} must be a string of at most 4096 bytes.`);
  }
  if (config.basePath) {
    validPrefixPath(config.basePath, `${filename}: basePath`);
    if (config.basePath.endsWith('/')) throw new Error(`${filename}: basePath must not end with /.`);
  }
  if (config.assetPrefix) {
    if (/^https?:\/\//i.test(config.assetPrefix)) {
      let url;
      try { url = new URL(config.assetPrefix); } catch { throw new Error(`${filename}: assetPrefix must be a valid HTTP(S) URL or pathname prefix.`); }
      if (url.username || url.password || /[\s\\?#]/.test(config.assetPrefix)) throw new Error(`${filename}: assetPrefix cannot contain credentials, query, fragment, whitespace or backslashes.`);
      const rawPathname = /^https?:\/\/[^/]*(\/.*)?$/i.exec(config.assetPrefix)?.[1] || '/';
      validPrefixPath(rawPathname, `${filename}: assetPrefix pathname`, { root: true });
      config.assetPrefix = url.href.replace(/\/+$/, '');
    } else {
      if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(config.assetPrefix)) throw new Error(`${filename}: assetPrefix only supports HTTP(S) URLs and pathname prefixes.`);
      const prefix = config.assetPrefix.startsWith('/') ? config.assetPrefix : '/' + config.assetPrefix;
      validPrefixPath(prefix, `${filename}: assetPrefix`, { root: true });
      // An explicit / selects root assets even when basePath is configured.
      config.assetPrefix = prefix.replace(/\/+$/, '') || '/';
    }
  }
  for (const key of ['compress', 'poweredByHeader', 'productionBrowserSourceMaps', 'trailingSlash', 'skipTrailingSlashRedirect', 'skipMiddlewareUrlNormalize']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${filename}: ${key} must be a boolean.`);
  }
  for (const key of ['redirects', 'headers', 'rewrites', 'generateBuildId']) {
    if (config[key] !== undefined && typeof config[key] !== 'function') throw new Error(`${filename}: ${key} must be a function.`);
  }
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) throw new Error(`${filename}: env must be an object of string values.`);
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(config.env)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key) || /^(?:NODE_|__)/i.test(key) || key === 'NEXT_RUNTIME' || key.startsWith('PRNEXT_')) throw new Error(`${filename}: env key "${key}" is reserved or not a JavaScript identifier.`);
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`${filename}: env.${key} must be a string or undefined.`);
    environment[key] = value;
  }
  config.env = environment;
  if (config.skipProxyUrlNormalize !== undefined) {
    if (typeof config.skipProxyUrlNormalize !== 'boolean') throw new TypeError('skipProxyUrlNormalize must be a boolean');
    config.skipMiddlewareUrlNormalize = config.skipProxyUrlNormalize;
  }
  config.cacheHandlers = validateCacheHandlers(config.cacheHandlers);
  config.cacheHandler = validateCacheHandler(config.cacheHandler);
  if (config.cacheMaxMemorySize !== undefined && (!Number.isSafeInteger(config.cacheMaxMemorySize) || config.cacheMaxMemorySize < 0 || config.cacheMaxMemorySize > 1024 * 1024 * 1024)) throw new TypeError('cacheMaxMemorySize must be an integer between 0 and 1 GiB');
  config.images = validateImagesConfig(config.images, { basePath: config.basePath, assetPrefix: config.assetPrefix, trailingSlash: config.trailingSlash });
  return config;
}

/** Config and its relative imports are evaluated fresh on every build. */
export async function loadProjectConfig(projectRoot, { dev = false, envMode, phase = dev ? constants.PHASE_DEVELOPMENT_SERVER : constants.PHASE_PRODUCTION_BUILD } = {}) {
  const root = path.resolve(projectRoot);
  loadEnvConfig(root, { dev, mode: envMode });
  const files = await readdir(root);
  const names = files.filter(name => configName.test(name));
  const unsupportedFiles = files.filter(name => /^(?:next|prnext)\.config\.(?:mts|cts|jsx|tsx|json)$/.test(name));
  if (unsupportedFiles.length) throw new Error(`Unsupported configuration file ${unsupportedFiles.join(', ')}. Use .js, .mjs, .cjs or .ts.`);
  if (names.length > 1) throw new Error(`Multiple configuration files found: ${names.sort().join(', ')}. Keep one next.config.* or prnext.config.* file.`);
  if (!names.length) return validateProjectConfig({});
  const filename = path.join(root, names[0]);
  let input = await importConfig(filename);
  if (typeof input === 'function') input = await input(phase, { defaultConfig: { ...defaults, env: {}, experimental: { ...defaults.experimental } } });
  return validateProjectConfig(input, names[0]);
}

export function defineEnvironment(config, env = process.env) {
  const publicValues = Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith('NEXT_PUBLIC_') && value !== undefined));
  const values = { ...publicValues, ...config.env };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)]));
}

export async function generateBuildId(config, { dev = false } = {}) {
  const generated = !dev && config.generateBuildId ? await config.generateBuildId() : null;
  if (generated === null) return randomUUID();
  if (typeof generated !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(generated)) throw new Error('generateBuildId must return null or a nonempty URL-safe string of at most 128 characters (letters, digits, _ or -).');
  return generated;
}
