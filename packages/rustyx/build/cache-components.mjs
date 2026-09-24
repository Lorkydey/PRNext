import {generateMapped} from './source-maps.mjs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cachedTransform } from './transform-cache.mjs';
const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;
const cacheDirective = directive => /^use cache(?:$|:)/.test(directive.value.value);

export function transformCacheComponents(source, file, { enabled, projectRoot, mode = 'rsc', buildId, segment: configuredSegment, handlers = {} }) {
  if (!source.includes('use cache')) return source;
  return cachedTransform('cache-components',source,[file,enabled,projectRoot,mode,buildId,configuredSegment,handlers],()=>transformUncached(source,file,{enabled,projectRoot,mode,buildId,configuredSegment,handlers}));
}
function transformUncached(source,file,{enabled,projectRoot,mode,buildId,configuredSegment,handlers}) {
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
  let program;
  traverse(ast, { Program(value) { program = value; value.stop(); } });
  const moduleDirective = ast.program.directives.find(cacheDirective);
  const client = ast.program.directives.some(item => item.value.value === 'use client');
  const exported = new Set();
  const defaultExport = ast.program.body.find(node => t.isExportDefaultDeclaration(node))?.declaration;
  const defaultName = t.isIdentifier(defaultExport) ? defaultExport.name : undefined;
  if (moduleDirective && defaultName) exported.add(defaultName);
  if (moduleDirective) for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement)) {
      for (const name of Object.keys(t.getOuterBindingIdentifiers(statement.declaration || {}))) exported.add(name);
      for (const specifier of statement.specifiers) if (specifier.local) exported.add(specifier.local.name);
      if (statement.source && statement.exportKind !== 'type') throw new Error(`A 'use cache' module must define its cached exports locally (${file}).`);
    }
  }
  if (moduleDirective) {
    for (const name of exported) {
      const binding = program.scope.getBinding(name);
      let node = binding?.path.node;
      if (t.isVariableDeclarator(node)) node = node.init;
      if (!t.isFunction(node) || !node.async) throw new Error(`A 'use cache' module must export async functions (${name} in ${file}).`);
    }
    if (defaultExport && !defaultName && (!t.isFunction(defaultExport) || !defaultExport.async)) throw new Error(`A 'use cache' module must export async functions (${file}).`);
  }
  const helper = program.scope.generateUidIdentifier('rustyxCache');
  let transformed = false;
  traverse(ast, { Function: { exit(fn) {
    const own = fn.node.body.directives?.find(cacheDirective);
    const name = fn.node.id?.name || (fn.parentPath.isVariableDeclarator() ? fn.parentPath.node.id.name : undefined);
    const directive = own || (moduleDirective && (exported.has(name) || fn.parentPath.isExportDefaultDeclaration()) ? moduleDirective : null);
    if (!directive) return;
    if (!enabled) throw new Error(`'use cache' requires cacheComponents:true in the project configuration (${file}).`);
    if (client || mode === 'browser' || mode === 'ssr') throw new Error(`'use cache' is server-only and cannot be defined in a Client Component (${file}).`);
    if (!fn.node.async || fn.node.generator || fn.isObjectMethod() || fn.isClassMethod() || fn.isClassPrivateMethod()) throw new Error(`'use cache' requires an async function (${file}).`);
    const kind = directive.value.value === 'use cache' ? 'default' : directive.value.value.slice('use cache:'.length).trim();
    if (!['default', 'remote', 'private'].includes(kind) && !Object.hasOwn(handlers, kind)) throw new Error(`Unsupported cache directive ${directive.value.value}; configure cacheHandlers.${kind} (${file}).`);
    const captures = new Map();
    fn.traverse({ ReferencedIdentifier(ref) {
      if (ref.node.name === 'arguments' && fn.isArrowFunctionExpression()) {
        let owner = ref.getFunctionParent();
        while (owner?.isArrowFunctionExpression()) owner = owner.getFunctionParent();
        if (!owner || !owner.findParent(parent => parent === fn)) throw new Error(`'use cache' arrows cannot capture lexical arguments; pass an explicit array parameter (${file}).`);
      }
      const binding = ref.scope.getBinding(ref.node.name);
      if (!binding || binding.scope === program.scope || binding.scope === fn.scope || binding.path === fn || binding.scope.path.findParent(parent => parent === fn)) return;
      captures.set(ref.node.name, binding);
    }, ThisExpression() { throw new Error(`'use cache' functions cannot depend on this (${file}).`); },
    'AssignmentExpression|UpdateExpression'(ref) {
      for (const name of Object.keys(t.getBindingIdentifiers(ref.node.left || ref.node.argument))) {
        const binding = ref.scope.getBinding(name);
        if (binding && binding.scope !== fn.scope && binding.scope !== program.scope && !binding.scope.path.findParent(parent => parent === fn)) throw new Error(`'use cache' cannot mutate captured variable ${name} (${file}).`);
      }
    } });
    if (fn.node.body.directives) fn.node.body.directives = fn.node.body.directives.filter(item => !cacheDirective(item));
    const id = createHash('sha256').update(JSON.stringify([buildId, path.relative(projectRoot, file), fn.node.start, kind])).digest('hex');
    const args = fn.scope.generateUidIdentifier('cacheArgs');
    const decoded = fn.scope.generateUidIdentifier('decodedArgs');
    const captured = fn.scope.generateUidIdentifier('capturedArgs');
    const original = t.functionExpression(null, fn.node.params, t.isBlockStatement(fn.node.body) ? fn.node.body : t.blockStatement([t.returnStatement(fn.node.body)]), false, true);
    const segment = configuredSegment ?? /(?:^|[/\\])(page|layout)\.[cm]?[jt]sx?$/.exec(file)?.[1];
    const pageFunction = segment && (fn.parentPath.isExportDefaultDeclaration() || name && name === defaultName);
    const body = [];
    if (captures.size) body.push(t.variableDeclaration('const', [t.variableDeclarator(t.arrayPattern([...captures.keys()].map(name => t.identifier(name))), captured)]));
    body.push(t.returnStatement(t.callExpression(t.memberExpression(original, t.identifier('apply')), [t.identifier('undefined'), decoded])));
    fn.node.params = [t.restElement(args)];
    fn.node.body = t.blockStatement([t.returnStatement(t.callExpression(helper, [t.stringLiteral(id), t.stringLiteral(kind), t.arrayExpression([...captures.keys()].map(name => t.identifier(name))), args, t.arrowFunctionExpression([captured, decoded], t.blockStatement(body), true), t.stringLiteral(pageFunction ? segment : '')]))]);
    transformed = true;
  } } });
  if (!transformed) return source;
  ast.program.directives = ast.program.directives.filter(item => !cacheDirective(item));
  ast.program.body.unshift(t.importDeclaration([t.importSpecifier(helper, t.identifier('invokeCache'))], t.stringLiteral('rustyx-internal:use-cache')));
  return generateMapped(generate, ast, { retainLines: true }, source, file);
}
