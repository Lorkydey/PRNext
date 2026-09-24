const adapters = new Map([
  ['dist/shared/lib/router-context.shared-runtime','next-router-context'],
  ['dist/shared/lib/router-context','next-router-context'],
  ['dist/shared/lib/app-router-context.shared-runtime','next-app-router-context'],
]);
// Only explicit, tested private contracts are adapted. Unknown internals still
// fail instead of silently importing a second framework runtime from npm.
export function frameworkImportName(specifier) {
  const name=specifier.slice(specifier.indexOf('/')+1).replace(/\.js$/,'');
  return adapters.get(name) || name;
}
