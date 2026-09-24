import { transformAsync } from '@babel/core';
import refresh from 'react-refresh/babel';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedAsyncTransform } from './transform-cache.mjs';
import {inlineSourceMap} from './source-maps.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const devClientFile = path.join(packageRoot, 'runtime/dev-client.mjs');

/** Keep React renderers and framework contexts identical across rebuilt ESM chunks. */
export function devSingletonsPlugin() {
  return { name: 'rustyx-development-singletons', setup(build) {
    build.onLoad({ filter: /\.[cm]?js$/, namespace: 'file' }, async args => {
      const filename = args.path.replaceAll(path.sep, '/');
      if (!/\/node_modules\/(?:react|react-dom|react-refresh|react-server-dom-webpack)\//.test(filename) && !(args.path.startsWith(path.join(packageRoot, 'compat') + path.sep) && args.path.endsWith('.cjs'))) return;
      const source = await readFile(args.path, 'utf8');
      // These packages and adapters expose CommonJS entry points. ESM files are
      // left alone; wrapping their declarations would change module semantics.
      if (!/\b(?:module\.exports|exports\.)/.test(source)) return;
      return { contents: `const __rustyxModules=globalThis.__RUSTYX_DEV_MODULES__||=new Map();const __rustyxKey=${JSON.stringify(filename)};if(__rustyxModules.has(__rustyxKey)){module.exports=__rustyxModules.get(__rustyxKey)}else{\n${source}\n__rustyxModules.set(__rustyxKey,module.exports);}`, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  } };
}

function componentExports(program) {
  let count = 0;
  for (const statement of program.body) {
    if (statement.type === 'ExportAllDeclaration') return false;
    if (statement.type === 'ExportDefaultDeclaration') {
      count++;
      const value = statement.declaration;
      const name = value.id?.name || (value.type === 'Identifier' ? value.name : '');
      if (!/^[A-Z]/.test(name)) return false;
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
    if (statement.source) return false;
    const declaration = statement.declaration;
    const names = declaration?.type === 'VariableDeclaration' ? declaration.declarations.map(item => item.id.name)
      : declaration?.id ? [declaration.id.name] : statement.specifiers.filter(item => item.exportKind !== 'type').map(item => item.local?.name);
    for (const name of names) { count++; if (!name || !/^[A-Z]/.test(name)) return false; }
  }
  return count > 0;
}

/** The official React transform records hook signatures and refresh families. */
export function createRefreshTransform(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const canonicalRoot = realpath(projectRoot).catch(() => projectRoot);
  return async (source, filename) => {
    if (filename.includes(`${path.sep}node_modules${path.sep}`) || filename.includes(`${path.sep}.rustyx-build-`)) return source;
    // Bundlers resolve symlinks (including /var -> /private/var on macOS).
    // Compare against both spellings so temporary/linked apps still refresh.
    const root = filename.startsWith(projectRoot + path.sep) ? projectRoot : await canonicalRoot;
    if (!filename.startsWith(root + path.sep)) return source;
    const hash = createHash('sha256').update(source).digest('hex');
    return cachedAsyncTransform('fast-refresh',source,[projectRoot,filename],async () => {
      const result = await transformAsync(source, { filename, babelrc: false, configFile: false,
        ast: true, sourceMaps: true, sourceFileName:filename, sourceType: 'unambiguous',
        parserOpts: { plugins: ['jsx', ...(/\.tsx?$/.test(filename) ? ['typescript'] : [])] },
        plugins: [[refresh, { skipEnvCheck: true, refreshReg: '__rustyxRefreshReg', refreshSig: '__rustyxRefreshSig' }]],
      });
      const id = path.relative(root, filename).replaceAll(path.sep, '/');
      // An ESM import changes webpack's interpretation of module.exports.
      // Keep script/CommonJS inputs in their original module format.
      const runtime = result.ast.program.sourceType === 'script'
        ? `const{register:__rustyxRegister,signature:__rustyxRefreshSig,registerModule:__rustyxRegisterModule}=require(${JSON.stringify(devClientFile)});`
        : `import{register as __rustyxRegister,signature as __rustyxRefreshSig,registerModule as __rustyxRegisterModule}from ${JSON.stringify(devClientFile)};`;
      const strict = result.ast.program.directives.some(item => item.value.value === 'use strict') ? '"use strict";' : '';
      const prefix = `${strict}${runtime}function __rustyxRefreshReg(type,id){__rustyxRegister(type,${JSON.stringify(id + ':')}+id)};\n`;
      return inlineSourceMap(prefix + result.code + `\n__rustyxRegisterModule(${JSON.stringify(id)},${JSON.stringify(hash)},${componentExports(result.ast.program)});\n`,{...result.map,mappings:';'+result.map.mappings});
    });
  };
}
