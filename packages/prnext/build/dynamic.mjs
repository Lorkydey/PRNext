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
const sources = new Set(['next/dynamic', 'next/dynamic.js', 'prnext/dynamic', 'prnext/dynamic.js']);

function importedDynamic(binding) {
  if (!binding) return false;
  const declaration = binding.path;
  if (declaration.isImportDefaultSpecifier() || declaration.isImportNamespaceSpecifier() ||
      declaration.isImportSpecifier() && (declaration.node.imported.name ?? declaration.node.imported.value) === 'default') {
    return sources.has(declaration.parentPath.node.source.value);
  }
  if (!declaration.isVariableDeclarator()) return false;
  let value = declaration.node.init;
  if (t.isMemberExpression(value) && propertyName(value) === 'default') value = value.object;
  return t.isCallExpression(value) && t.isIdentifier(value.callee, { name: 'require' }) &&
    !declaration.scope.getBinding('require') && value.arguments.length === 1 &&
    t.isStringLiteral(value.arguments[0]) && sources.has(value.arguments[0].value);
}

function propertyName(node) {
  return !node.computed && t.isIdentifier(node.key ?? node.property)
    ? (node.key ?? node.property).name : t.isStringLiteral(node.key ?? node.property) ? (node.key ?? node.property).value : undefined;
}

// A spread after a property may replace it. Only erase a loader when the final
// ssr value is the literal false; runtime options retain their normal semantics.
function option(object, name) {
  if (!object?.isObjectExpression()) return undefined;
  for (const property of [...object.get('properties')].reverse()) {
    if (property.isSpreadElement() || propertyName(property.node) === undefined) return undefined;
    if (propertyName(property.node) !== name) continue;
    return property.isObjectProperty() ? property.get('value') : name === 'loader' && property.isObjectMethod() ? property : undefined;
  }
}

function mayOverride(object, name) {
  if (!object?.node) return false;
  if (!object.isObjectExpression()) return true;
  return object.node.properties.some(property => t.isSpreadElement(property) || propertyName(property) === undefined || propertyName(property) === name);
}

function loaderBody(loader) {
  if (!loader?.isIdentifier()) return loader;
  const binding = loader.scope.getBinding(loader.node.name);
  if (!binding?.constant) return loader;
  if (binding.path.isFunctionDeclaration()) return binding.path;
  const initial = binding.path.isVariableDeclarator() && binding.path.get('init');
  return initial && (initial.isArrowFunctionExpression() || initial.isFunctionExpression()) ? initial : loader;
}

/** Add shared hydration IDs without resolving, evaluating or eagerly importing loaders. */
export function transformDynamicImports(source, filename, { projectRoot, mode = 'browser' } = {}) {
  if (![...sources].some(name => source.includes(name))) return source;
  projectRoot ||= process.cwd();
  return cachedTransform('dynamic',source,[filename,projectRoot,mode],()=>transformDynamicImportsUncached(source,filename,{projectRoot,mode}));
}

function transformDynamicImportsUncached(source, filename, {projectRoot,mode}) {
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: filename,
    plugins: ['jsx', ...(/\.tsx?$/.test(filename) ? ['typescript'] : [])] });
  const relative = path.relative(projectRoot || process.cwd(), filename).replaceAll(path.sep, '/');
  let changed = false;
  traverse(ast, {
    CallExpression(call) {
      let callee = call.get('callee');
      if (callee.isMemberExpression() && propertyName(callee.node) === 'default') callee = callee.get('object');
      if (!callee.isIdentifier() || !importedDynamic(callee.scope.getBinding(callee.node.name))) return;
      const args = call.get('arguments');
      if (args.length > 2 || args.some(argument => argument.isSpreadElement())) throw new Error(`next/dynamic accepts a loader and optional options object (${filename}).`);
      if (!args.length) return;
      const objectFirst = args[0].isObjectExpression();
      const firstOptions = objectFirst ? args[0] : undefined;
      const secondOptions = args[1];
      let loader = option(secondOptions, 'loader') || option(firstOptions, 'loader') || (!objectFirst ? args[0] : undefined);
      if (!loader?.node) return;
      const ssr = option(secondOptions, 'ssr') || (!mayOverride(secondOptions, 'ssr') ? option(firstOptions, 'ssr') : undefined);
      const noSSR = ssr?.isBooleanLiteral({ value: false });
      if (noSSR && mode === 'rsc') throw new Error(`ssr: false is not allowed with next/dynamic in an App Server Component (${filename}). Move this dynamic component into a module marked 'use client'.`);

      const imports = new Set();
      const inspect = node => {
        const value = t.isImportExpression(node) ? node.source : t.isCallExpression(node) && t.isImport(node.callee) ? node.arguments[0] : undefined;
        if (!value) return;
        if (t.isStringLiteral(value)) imports.add(value.value);
        else if (t.isTemplateLiteral(value) && !value.expressions.length) imports.add(value.quasis[0].value.cooked);
        else throw new Error(`next/dynamic import paths must be string literals (${filename}).`);
      };
      const body = loaderBody(loader);
      inspect(body.node);
      body.traverse({ CallExpression(value) { inspect(value.node); }, ImportExpression(value) { inspect(value.node); } });
      // Custom loaders can return an already available component. They still
      // need a stable hydration identity even when no import() is present.
      const keys = imports.size ? [...imports] : [`loader:${generate(body.node, { compact: true, comments: false }).code}`];
      const ids = keys.map(specifier => 'dynamic-' + createHash('sha256').update(relative + '\0' + specifier).digest('hex').slice(0, 20));
      const generated = t.objectProperty(t.identifier('loadableGenerated'), t.objectExpression([
        t.objectProperty(t.identifier('modules'), t.arrayExpression(ids.map(id => t.stringLiteral(id)))),
      ]));

      if (noSSR && mode !== 'browser') {
        const empty = t.arrowFunctionExpression([], t.nullLiteral(), true);
        loader.replaceWith(loader.isObjectMethod() ? t.objectProperty(loader.node.key, empty, loader.node.computed) : empty);
      }
      else if (loader.isCallExpression() && (t.isImport(loader.node.callee) || imports.size)) {
        // The legacy direct import form must not execute at module evaluation.
        loader.replaceWith(t.arrowFunctionExpression([], loader.node));
      }
      const target = secondOptions || firstOptions;
      if (target?.isObjectExpression()) target.node.properties.push(generated);
      else if (target?.node) target.replaceWith(t.objectExpression([t.spreadElement(target.node), generated]));
      else call.node.arguments.push(t.objectExpression([generated]));
      changed = true;
    },
  });
  return changed ? generateMapped(generate, ast, { comments: true }, source, filename) : source;
}
