const globalInput = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|(?:tsconfig|jsconfig)\.json|(?:prnext|next|contentlayer|postcss|tailwind)\.config\.|\.env|(?:src\/)?(?:middleware|proxy)\.[^/]+$|pages\/_document\.|(?:global-error|global-not-found)\.)/;
const generatedRouteFields = new Set(['module', 'client', 'css', 'cssScopes']);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const signature = value => JSON.stringify(stable(value));
const routeContract = manifest => manifest.routes.map(route => Object.fromEntries(Object.entries(route).filter(([key]) => !generatedRouteFields.has(key)))).sort((a, b) => a.id.localeCompare(b.id));
function actionContract(manifest) {
  const ids = Object.keys(manifest.app?.actions || {}).sort();
  if (!ids.length) return [];
  const metadata = manifest.devActions;
  if (metadata?.version !== 1 || metadata.complete !== true || manifest.devDependencyStatus?.complete !== true || !Array.isArray(metadata.actions)) return;
  const modules = new Set((manifest.devModules || []).map(record => record.route));
  const routed = new Set((manifest.devDependencies || []).flatMap(record => record.files));
  if (signature(metadata.actions.map(action => action.id).sort()) !== signature(ids)) return;
  const owners = new Set();
  for (const action of metadata.actions) {
    const owner = action.file + '\0' + action.binding;
    if (!modules.has(action.file) || !routed.has(action.file) || owners.has(owner) || !Array.isArray(action.runtimes)) return;
    owners.add(owner);
  }
  return [...metadata.actions].sort((a, b) => (a.file + '\0' + a.binding).localeCompare(b.file + '\0' + b.binding));
}

// Both committed graphs participate: removed imports belong to the old graph,
// newly introduced imports to the new one. No partial/unknown graph is proof.
export function selectiveDevelopmentRoutes(previous, next, { changed, affectedRoutes, affectedModules = [], nextAffected } = {}) {
  if (!previous || !changed?.length || !Array.isArray(affectedRoutes) || !nextAffected || nextAffected.complete !== true || !Array.isArray(nextAffected.unknown) || nextAffected.unknown.length || !Array.isArray(nextAffected.routes) ||
      previous.devDependencyStatus?.complete === false || next.devDependencyStatus?.complete === false || changed.some(file => globalInput.test(file))) return;
  // The visible URL is not proof of the rendered route under server rewrites,
  // localized routing, or intercepted/parallel branches. Keep these global
  // until the browser can certify every visible route identity.
  for (const manifest of [previous, next]) if (manifest.middleware || manifest.config?.i18n ||
      Object.values(manifest.customRoutes?.rewrites || {}).some(rules => rules.length) ||
      manifest.routes.some(route => route.parallel || route.interception)) return;
  if (signature([previous.config, previous.customRoutes, routeContract(previous)]) !== signature([next.config, next.customRoutes, routeContract(next)])) return;
  const before = actionContract(previous), after = actionContract(next);
  if (!before || !after || previous.app?.actionKey !== next.app?.actionKey ||
      signature(before.map(({id, ...action}) => action)) !== signature(after.map(({id, ...action}) => action))) return;
  const modules = new Set([...affectedModules, ...(nextAffected.modules || [])]);
  for (let i = 0; i < before.length; i++) if (before[i].id !== after[i].id && !modules.has(before[i].file)) return;
  const routes = [...new Set([...affectedRoutes, ...nextAffected.routes])].sort();
  return Buffer.byteLength(JSON.stringify(routes)) <= 32 * 1024 ? routes : undefined;
}

// An ensure/navigation transaction must prepare the new loader even when its
// destination differs from location.pathname until history is committed.
export function canSkipDevelopmentUpdate({ confirmed, navigation, ensuring, affectedRoutes, routes, pathname }) {
  if (!confirmed || navigation || ensuring || !Array.isArray(affectedRoutes) || !Array.isArray(routes)) return false;
  let parts; try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return false; }
  const matches = pattern => {
    const segments = pattern.split('/').filter(Boolean); let index = 0;
    for (const segment of segments) {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return true;
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return index < parts.length;
      if (index >= parts.length || !(segment.startsWith('[') && segment.endsWith(']')) && segment !== parts[index]) return false;
      index++;
    }
    return index === parts.length;
  };
  return routes.some(matches) && !affectedRoutes.some(matches);
}
