import {fileURLToPath} from 'node:url';
const adapters = new Map([
  ['dist/shared/lib/router-context.shared-runtime','next-router-context'],
  ['dist/shared/lib/router-context','next-router-context'],
  ['dist/shared/lib/app-router-context.shared-runtime','next-app-router-context'],
]);
// Keep the historical import alias for existing applications. npm's scoped
// package name adds a slash of its own, so strip the entire package prefix.
export const frameworkPackages = ['next', 'prnext', '@thomas.f/prnext'];
export const frameworkImportPattern = /^(?:next|prnext|@thomas\.f\/prnext)(?:\/|$)/;
export const frameworkSubpathPattern = /^(?:next|prnext|@thomas\.f\/prnext)\//;
export const frameworkRuntimeImportPattern = /^(?:next(?:\/|$)|(?:prnext|@thomas\.f\/prnext)\/)/;
// Only explicit, tested private contracts are adapted. Unknown internals still
// fail instead of silently importing a second framework runtime from npm.
export function frameworkImportName(specifier) {
  const name=specifier.replace(frameworkSubpathPattern, '').replace(/\.js$/,'');
  return adapters.get(name) || name;
}

// Application graphs must not traverse the programmatic build API's native tools.
// Outside a compiled application, the package root retains its full Node API.
export function applicationEntry(builder){
  builder.onResolve({filter:/^(?:prnext|@thomas\.f\/prnext)(?:\/route(?:\.js)?)?$/},()=>
    ({path:fileURLToPath(new URL('../runtime/typed-route.mjs',import.meta.url))}));
}
