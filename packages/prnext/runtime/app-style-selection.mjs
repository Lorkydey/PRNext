function ownsBranch(scope, branch) {
  const path = branch.replace(/#default$/, '');
  if (scope.kind === 'layout') return !scope.path || path === scope.path || path.startsWith(scope.path + '/');
  return path === scope.path && (scope.kind === 'default') === branch.endsWith('#default');
}

/** Parallel route entries include both canonical and intercepted alternatives.
 * Their actual router selection determines which sheets may become active. */
export function selectAppStyles(model) {
  if (!model.routing || !Array.isArray(model.cssScopes)) return;
  const branches = Object.values(model.routing.slots || {}).map(slot => slot.branch);
  model.cssScopes = model.cssScopes.filter(scope => (scope.kind === 'layout' && !scope.path) || branches.some(branch => ownsBranch(scope, branch)));
  model.css = [...new Set(model.cssScopes.flatMap(scope => scope.css || []))];
}

/** A retained parallel/intercepted slot keeps only the styles belonging to
 * that branch. Carrying the preceding route's complete list would leak its
 * inactive page globals into the new main page. */
export function retainAppStyles(model, previous) {
  selectAppStyles(model);
  if (!model.routing || !previous?.routing || model.globalError) return;
  const retained = Object.entries(model.routing.slots || {}).flatMap(([key, slot]) => {
    const old = previous.routing.slots?.[key];
    return old && old.branch === slot.branch && old.url === slot.url ? [slot.branch] : [];
  });
  if (!retained.length) return;
  const scopes = [...model.cssScopes || []];
  for (const scope of previous.cssScopes || []) {
    if (scopes.some(current => current.path === scope.path && current.kind === scope.kind)) continue;
    if (retained.some(branch => ownsBranch(scope, branch))) scopes.push(scope);
  }
  model.cssScopes = scopes;
  model.css = [...new Set([...(model.css || []), ...scopes.flatMap(scope => scope.css || [])])];
}
