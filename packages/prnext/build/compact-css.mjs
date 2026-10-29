import postcss from 'postcss';
import selectors from 'postcss-selector-parser';
import values from 'postcss-value-parser';
import { createHash } from 'node:crypto';

// Names are independent of compilation order and of which routes are built.
// A collision fails the build instead of changing one of two published maps.
export function compactCssModule(css, exports, {globals = new Set(), hash = name => 'p' + createHash('sha256').update(name).digest('base64url').slice(0, 10)} = {}) {
  const names = new Map(), reverse = new Map();
  for (const list of Object.values(exports)) for (const name of list.split(/\s+/).filter(Boolean)) {
    if (names.has(name) || globals.has(name)) continue;
    const short = hash(name);
    if (!/^[a-zA-Z_][\w-]*$/.test(short) || globals.has(short) && short!==name || reverse.has(short) && reverse.get(short) !== name) throw new Error('CSS Module compact-name collision.');
    names.set(name, short); reverse.set(short, name);
  }
  const root = postcss.parse(css);
  root.walkRules(rule => {
    rule.selector = selectors(ast => ast.walkClasses(node => {
      if (names.has(node.value)) node.value = names.get(node.value);
    })).processSync(rule.selector);
  });
  root.walkAtRules(/^(?:-webkit-)?keyframes$/i, rule => {
    const parsed = values(rule.params);
    parsed.walk(node => { if (node.type === 'word' && names.has(node.value)) node.value = names.get(node.value); });
    rule.params = parsed.toString();
  });
  root.walkDecls(/^(?:-webkit-)?animation(?:-name)?$/i, declaration => {
    const parsed = values(declaration.value);
    parsed.walk(node => { if (node.type === 'word' && names.has(node.value)) node.value = names.get(node.value); });
    declaration.value = parsed.toString();
  });
  return { css: root.toString(), names:[...names], mapping: Object.fromEntries(Object.entries(exports).map(([key, list]) => [key, list.split(/\s+/).map(name => names.get(name) || name).join(' ')])) };
}

export function globalCssNames(css, {local = true} = {}, result = new Set()) {
  const root = postcss.parse(css);
  root.walkRules(rule => {
    selectors(ast => ast.each(selector => {
      let global = !local;
      selector.each(node => {
        if (node.type === 'pseudo' && [':global',':local'].includes(node.value)) {
          if (node.nodes?.length) { if (node.value === ':global') node.walkClasses(item=>result.add(item.value)); }
          else global = node.value === ':global';
        } else if (global) { if(node.type==='class') result.add(node.value); node.walkClasses?.(item=>result.add(item.value)); }
      });
    })).processSync(rule.selector);
  });
  root.walkDecls(/^composes$/i, declaration => {
    const words = values(declaration.value).nodes.filter(node=>node.type==='word').map(node=>node.value);
    if (words.at(-1)==='global' && words.at(-2)==='from') for(const name of words.slice(0,-2)) result.add(name);
  });
  return result;
}
