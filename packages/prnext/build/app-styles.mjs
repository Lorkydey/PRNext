import path from 'node:path';

const stylesheet = /\.(?:css|scss|sass)$/i;
const conventions = ['layout', 'template', 'loading', 'error', 'notFound', 'not-found', 'default', 'page'];
// Native esbuild identifies virtual inputs with absolute paths. The webpack
// bridge uses the same namespaces with project-relative paths instead. Only
// strip framework namespaces here; a Windows drive letter is part of the path.
const styleNamespace = /^prnext-(?:css-mapping|compiled-css|app-empty|edge-empty):/;

/** Join RSC references with their real client dependency graphs, without
 * flattening CSS @import/composes dependencies into extra stylesheets. */
export function createAppStyleGraph(root) {
  const graph = new Map();
  const file = name => path.resolve(root, name.replace(styleNamespace, ''));
  return {
    alias(source, target) {
      if (file(source) !== file(target)) graph.set(file(source), new Set([file(target)]));
    },
    record(metafile) {
      for (const [name, input] of Object.entries(metafile?.inputs || {})) {
        const key = file(name), dependencies = graph.get(key) || new Set();
        for (const dependency of input.imports || []) if (!dependency.external) dependencies.add(file(dependency.path));
        graph.set(key, dependencies);
      }
    },
    collect(roots) {
      const seen = new Set(), styles = new Set();
      const pending = [...roots].reverse();
      while (pending.length) {
        const key = file(pending.pop());
        if (seen.has(key)) continue;
        seen.add(key);
        if (stylesheet.test(key)) { styles.add(key); continue; }
        const dependencies = [...graph.get(key) || []];
        for (let index = dependencies.length - 1; index >= 0; index--) pending.push(dependencies[index]);
      }
      return [...styles];
    },
  };
}

/** Layout scopes precede their descendants. Shared scopes produce the same
 * content-addressed sheet on every route, while a page never owns a sibling's
 * styles. A pruned parallel tree also includes its loading/error/default and
 * intercepted branches so a retained slot cannot lose its stylesheet. */
export function appStyleEntries(route) {
  const scopes = [];
  function add(files, path) {
    const roots = conventions.filter(name => name !== 'page' && name !== 'default').map(name => files?.[name]).filter(file => typeof file === 'string');
    if (roots.length) scopes.push({ path, kind:'layout', roots });
    for (const kind of ['default', 'page']) if (typeof files?.[kind] === 'string') scopes.push({ path, kind, roots:[files[kind]] });
  }
  if (route.routing) {
    function visit(node) {
      add(node.files, node.path || '');
      for (const child of node.children || []) visit(child);
      for (const name of Object.keys(node.slots || {}).sort()) visit(node.slots[name]);
    }
    visit(route.routing);
  } else {
    for (const segment of route.segments || []) add(segment, segment.path || '');
    if (route.file) add({ page: route.file }, '');
  }
  return scopes;
}

export const appStyleScopes = route => appStyleEntries(route).map(scope => scope.roots);

export function planAppStyleEntries(route, graph) {
  const included = new Set(), groups = [];
  for (const scope of appStyleEntries(route)) {
    const styles = graph.collect(scope.roots).filter(file => !included.has(file));
    for (const file of styles) included.add(file);
    if (styles.length) groups.push({ ...scope, styles });
  }
  return groups;
}

export const planAppStyles = (route, graph) => planAppStyleEntries(route, graph).map(scope => scope.styles);
