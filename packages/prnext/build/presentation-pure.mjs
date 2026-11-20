import * as t from '@babel/types';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const aliasExpressions = new Set([
  'Identifier', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
  'MemberExpression', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression',
  'ConditionalExpression', 'TemplateLiteral', 'TemplateElement',
  'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression',
]);

export const isPresentationMapCallback = node => t.isArrowFunctionExpression(node) ||
  t.isFunctionExpression(node) && !node.id && !node.generator;

/** Normalize checked const expressions in the analysis copy. The ordinary
 * component keeps its original evaluation order, including on guard failure. */
export function inlinePresentationAliases(ast, component) {
  let remaining = 4096;
  const unsupported = () => { throw new Error('Unverified local presentation bindings require ordinary rendering'); };
  function expressionSize(node, depth = 0) {
    if (depth > 32 || !aliasExpressions.has(node.type)) unsupported();
    if (t.isMemberExpression(node) && (node.computed || node.optional) ||
        t.isUnaryExpression(node) && !['!', '+', '-', '~', 'typeof'].includes(node.operator) ||
        t.isBinaryExpression(node) && ['in', 'instanceof'].includes(node.operator)) unsupported();
    const text = t.isStringLiteral(node) ? node.value : t.isTemplateElement(node) ? node.value.raw : '';
    let count = 1 + Math.ceil(Buffer.byteLength(text) / 64);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      if (key === 'typeAnnotation') continue;
      for (const child of [].concat(node[key] || [])) count += expressionSize(child, depth + 1);
    }
    return count;
  }
  function aliases(pattern, init, output, depth = 0) {
    if (t.isIdentifier(pattern)) { output.push([pattern.name, init]); return; }
    if (depth > 8 || !t.isObjectPattern(pattern) || !pattern.properties.length) unsupported();
    for (const field of pattern.properties) {
      if (!t.isObjectProperty(field) || field.computed || !t.isIdentifier(field.key)) unsupported();
      aliases(field.value, t.memberExpression(t.cloneNode(init, true), t.cloneNode(field.key)), output, depth + 1);
    }
  }
  traverse(ast, {
    Function(fn) {
      const parent = fn.parentPath;
      const mapCallback = isPresentationMapCallback(fn.node) && fn.listKey === 'arguments' && fn.key === 0 &&
        parent.isCallExpression() && t.isMemberExpression(parent.node.callee) &&
        !parent.node.callee.computed && t.isIdentifier(parent.node.callee.property, { name: 'map' });
      if (fn.node !== component && !mapCallback || !fn.get('body').isBlockStatement()) return;
      const statements = fn.get('body').get('body');
      if (statements.length <= 1) return;
      const result = statements.at(-1);
      const declarations = statements.slice(0, -1);
      if (fn.node.body.directives.length || !result.isReturnStatement() || !result.node.argument ||
          declarations.length > 32 || declarations.some(statement => !statement.isVariableDeclaration({ kind: 'const' }))) unsupported();
      for (const statement of declarations) for (const declaration of statement.get('declarations')) {
        const init = declaration.get('init');
        if (!init.node) unsupported();
        expressionSize(init.node);
        const free = new Map();
        const record = ref => {
          const binding = ref.scope.getBinding(ref.node.name);
          if (binding?.path.isVariableDeclarator() && binding.path.node.start >= declaration.node.start) unsupported();
          free.set(ref.node.name, binding);
        };
        if (init.isReferencedIdentifier()) record(init);
        init.traverse({ ReferencedIdentifier: record });
        const entries = [];
        aliases(declaration.node.id, init.node, entries);
        for (const [name, expression] of entries) {
          const binding = declaration.scope.getBinding(name);
          if (!binding?.constant || binding.path !== declaration || !binding.referencePaths.length) unsupported();
          remaining -= expressionSize(expression) * binding.referencePaths.length;
          if (remaining < 0) unsupported();
          for (const ref of binding.referencePaths) {
            if (!ref.isIdentifier() || ref.node.start <= declaration.node.end ||
                [...free].some(([id, owner]) => ref.scope.getBinding(id) !== owner)) unsupported();
            ref.replaceWith(t.cloneNode(expression, true));
          }
        }
      }
      for (const statement of declarations) statement.remove();
    },
  });
}

/** Inline only scalar, immutable local helper expressions into the analysis
 * copy. The source/ordinary fallback is untouched. Every argument must be used:
 * dropping an unused argument could remove an application getter or throw.
 */
export function inlinePresentationHelpers(path) {
  const replacements=new Map();
  let visits=0,expansions=0;
  function expression(node,scope,parameters=new Map(),used=new Set(),stack=new Set(),anchor=Infinity) {
    if(++visits>12000)throw new RangeError('Pure helper analysis budget');
    if(t.isIdentifier(node)){
      if(parameters.has(node.name)){used.add(node.name);return t.cloneNode(parameters.get(node.name),true);}
      const binding=scope.getBinding(node.name);
      if(binding?.constant&&binding.kind==='const'&&binding.path.isVariableDeclarator()&&binding.path.node.start<anchor){
        const value=binding.path.node.init;
        if(value&&['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral'].includes(value.type))return t.cloneNode(value,true);
      }
      if(node.name==='undefined'&&!binding)return t.identifier('undefined');
      throw new Error('Helper closes over an unverified value');
    }
    if(t.isCallExpression(node))return call(node,scope,parameters,used,stack,anchor);
    if(['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral'].includes(node.type))return t.cloneNode(node,true);
    if(!['MemberExpression','UnaryExpression','BinaryExpression','LogicalExpression','ConditionalExpression','TemplateLiteral','TemplateElement','TSAsExpression','TSNonNullExpression','TSSatisfiesExpression'].includes(node.type))throw new Error('Helper is not a scalar expression');
    if(t.isMemberExpression(node)&&(node.computed||node.optional)||t.isUnaryExpression(node)&&!['!','+','-','~','typeof'].includes(node.operator)||t.isBinaryExpression(node)&&['in','instanceof'].includes(node.operator))throw new Error('Unverified helper operation');
    const clone=t.cloneNode(node,true);
    for(const key of t.VISITOR_KEYS[node.type]||[]){
      if(t.isMemberExpression(node)&&key==='property'||key==='typeAnnotation')continue;
      const value=node[key];
      if(Array.isArray(value))clone[key]=value.map(child=>child?expression(child,scope,parameters,used,stack,anchor):child);
      else if(value)clone[key]=expression(value,scope,parameters,used,stack,anchor);
    }
    return clone;
  }
  function call(node,scope,parameters=new Map(),used=new Set(),stack=new Set(),anchor=node.start) {
    if(!t.isIdentifier(node.callee)||stack.size>=8||++expansions>64)throw new Error('Helper expansion budget');
    const binding=scope.getBinding(node.callee.name);
    if(!binding?.constant||stack.has(binding))throw new Error('Mutable or recursive helper');
    const fn=binding.path.isFunctionDeclaration()?binding.path.node:binding.path.isVariableDeclarator()?binding.path.node.init:undefined;
    if(binding.path.isVariableDeclarator()&&(binding.kind!=='const'||binding.path.node.start>=anchor))throw new Error('Helper declaration may be in its temporal dead zone');
    if(!fn||!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(fn.type)||fn.async||fn.generator||fn.params.length!==node.arguments.length||!fn.params.every(p=>t.isIdentifier(p)))throw new Error('Unsupported helper signature');
    let body=fn.body;
    if(t.isBlockStatement(body)){
      if(body.directives.length||body.body.length!==1||!t.isReturnStatement(body.body[0])||!body.body[0].argument)throw new Error('Helper has effects or boundaries');
      body=body.body[0].argument;
    }
    function argument(arg){
      if(t.isIdentifier(arg)&&parameters.has(arg.name)){used.add(arg.name);return t.cloneNode(parameters.get(arg.name),true);}
      if(t.isFunction(arg)||t.isSpreadElement(arg))throw new Error('Helper arguments must remain scalar');
      if(t.isCallExpression(arg)&&t.isIdentifier(arg.callee))return call(arg,scope,parameters,used,stack,anchor);
      const copy=t.cloneNode(arg,true);
      for(const key of t.VISITOR_KEYS[arg.type]||[]){
        if(t.isMemberExpression(arg)&&!arg.computed&&key==='property')continue;
        const value=arg[key];
        if(Array.isArray(value))copy[key]=value.map(x=>x?argument(x):x);else if(value)copy[key]=argument(value);
      }
      return copy;
    }
    const arguments_=node.arguments.map(argument);
    const locals=new Map(fn.params.map((p,i)=>[p.name,arguments_[i]])),reads=new Set(),nested=new Set(stack);nested.add(binding);
    const result=expression(body,binding.path.scope,locals,reads,nested,anchor);
    if(fn.params.some(p=>!reads.has(p.name)))throw new Error('Unused helper argument');
    return result;
  }
  function walk(node) {
    if(!node||typeof node!=='object')return node;
    if(replacements.has(node))return t.cloneNode(replacements.get(node),true);
    const copy=t.cloneNode(node,true);
    for(const key of t.VISITOR_KEYS[node.type]||[]){
      const value=node[key];
      if(Array.isArray(value))copy[key]=value.map(child=>walk(child));else if(value)copy[key]=walk(value);
    }
    return copy;
  }
  path.traverse({CallExpression(p){if(t.isIdentifier(p.node.callee)){try{replacements.set(p.node,call(p.node,p.scope));}catch{/* Ordinary source is retained. */}}}});
  return walk(path.node);
}
