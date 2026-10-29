import path from 'node:path';
import { builtinModules } from 'node:module';
import { analyzeSource } from './source-analysis.mjs';
import { frameworkImportName, frameworkImportPattern } from './framework-imports.mjs';

const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const interactive = new Set(['link','image','head','script','dynamic','router','compat/router','next-router-context','next-app-router-context']);
const namespace = /^prnext-(?:css-mapping|compiled-css|app-empty|edge-empty):/;

export function createHtmlOnlyGraph(root) {
  const graph = new Map(), issues = new Map();
  const file = value => path.resolve(root, value.replace(namespace, ''));
  function issue(filename, reason) {
    const key = file(filename);
    if (!issues.has(key)) issues.set(key, reason);
  }
  return {
    issue,
    alias(source, target) {
      if (file(source) !== file(target)) graph.set(file(source), [{ path:file(target) }]);
    },
    source(filename, source) {
      const { program, directives, computedRequire, imports } = analyzeSource(source, filename);
      if (directives.includes('use client')) issue(filename, 'a Client Component (use client)');
      if (computedRequire) issue(filename, 'a computed require() whose dependencies cannot be validated');
      for (const dependency of imports) if (frameworkImportPattern.test(dependency.path) && interactive.has(frameworkImportName(dependency.path))) issue(filename, `interactive framework import ${dependency.path}; use ordinary HTML elements instead`);
      const pending = [program];
      while (pending.length) {
        const node = pending.pop();
        if (node.directive === 'use server') issue(filename, 'a Server Action (use server)');
        if (node.type === 'ImportExpression' && typeof node.source?.value !== 'string') issue(filename, 'a computed import() whose dependencies cannot be validated');
        if (node.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier' && ['script','iframe','object','embed'].includes(node.name.name.toLowerCase())) issue(filename, `a <${node.name.name}> element`);
        if (node.type === 'JSXAttribute' && node.name?.type === 'JSXIdentifier' && /^on[A-Z]/.test(node.name.name)) issue(filename, `interactive event property ${node.name.name}`);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) { for (const child of value) if (child?.type) pending.push(child); }
          else if (value && typeof value === 'object' && value.type) pending.push(value);
        }
      }
    },
    record(metafile) {
      for (const [name, input] of Object.entries(metafile?.inputs || {})) {
        const key=file(name), dependencies=graph.get(key) || [];
        for (const dependency of input.imports || []) {
          if (!dependency.external) dependencies.push({path:file(dependency.path)});
          else if (!builtins.has(dependency.path) && !/^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/.test(dependency.path) && !/^\.\.\/compat\/(?:navigation|headers|cache|server|font-local|font-google|og)\.cjs$/.test(dependency.path)) {
            dependencies.push({external:dependency.path});
          }
        }
        graph.set(key,dependencies);
      }
    },
    validate(route) {
      const roots = new Set([route.file, ...Object.values(route.segments || {}).flatMap(segment => Object.values(segment).filter(value => typeof value === 'string' && /\.[cm]?[jt]sx?$/.test(value))), ...(route.metadataFiles || []).map(item => item.file)].filter(Boolean));
      const pending=[...roots].map(file), seen=new Set();
      while (pending.length) {
        const current=pending.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        if (issues.has(current)) throw new Error(`htmlOnly route ${route.pattern} reaches ${issues.get(current)} in ${path.relative(root,current)}.`);
        for (const dependency of graph.get(current) || []) {
          if (dependency.external) throw new Error(`htmlOnly route ${route.pattern} reaches unverified external dependency ${dependency.external} from ${path.relative(root,current)}. Bundle a static server dependency or remove it from this HTML-only route.`);
          pending.push(dependency.path);
        }
      }
    },
  };
}
