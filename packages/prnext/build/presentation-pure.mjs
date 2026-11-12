import * as t from '@babel/types';

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
