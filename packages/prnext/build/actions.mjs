import {cachedTransform} from './transform-cache.mjs';
import {generateMapped} from './source-maps.mjs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;
function hasDirective(node,value) { return node?.directives?.some(item=>item.value.value===value); }
function removeDirective(node,value) { if(node?.directives) node.directives=node.directives.filter(item=>item.value.value!==value); }

export function createServerActions({ projectRoot }) {
  const salt = randomBytes(32);
  const modules = new Map();
  const actions = new Map();
  const configured = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
  if (configured && (!/^[A-Za-z0-9+/]+={0,2}$/.test(configured) || ![16,24,32].includes(Buffer.from(configured,'base64').length))) throw new Error('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY must be a base64-encoded 16, 24, or 32 byte AES key.');
  const actionKey = configured ? Buffer.from(configured,'base64').toString('base64') : randomBytes(32).toString('base64');
  function identity(file,name) { return createHmac('sha256',salt).update(path.relative(projectRoot,file).replaceAll(path.sep,'/')+'\0'+name).digest('hex'); }
  function register(file,name,binding) {
    const id=identity(file,name);
    if(!actions.has(id)) actions.set(id,{id,file,binding});
    return id;
  }

  function analyze(source,file) {
    const key=file+'\0'+createHash('sha256').update(source).digest('hex');
    if(modules.has(key))return modules.get(key);
    const template=JSON.parse(cachedTransform('server-action-analysis',source,[projectRoot,file],()=>JSON.stringify(analyzeTemplate(source,file))));
    const ids=new Map(template.registrations.map(item=>[item.id,register(file,item.name,item.binding)]));
    let server=template.server;
    for(const [previous,current]of ids)server=server.replaceAll(previous,current);
    const result={...template,server,declared:template.declared.map(item=>({...item,id:ids.get(item.id)}))};
    delete result.registrations;
    modules.set(key,result);
    return result;
  }
  function analyzeTemplate(source,file) {
    const registrations=[],templateSalt=randomBytes(32);
    function register(_file,name,binding) {
      const id=createHmac('sha256',templateSalt).update(name).digest('hex');
      registrations.push({name,binding,id});return id;
    }
    const ast=parse(source,{sourceType:'unambiguous',sourceFilename:file,plugins:['jsx',...(/\.tsx?$/.test(file)?['typescript']:[])]});
    const moduleServer=hasDirective(ast.program,'use server');
    const moduleClient=hasDirective(ast.program,'use client');
    if(moduleServer&&moduleClient) throw new Error(`A module cannot use both 'use client' and 'use server': ${file}`);
    let program;
    traverse(ast,{Program(value){program=value;value.stop();}});
    const registration=program.scope.generateUidIdentifier('registerServerReference');
    const decrypt=program.scope.generateUidIdentifier('decryptBoundArgs');
    const bind=program.scope.generateUidIdentifier('bindEncryptedReference');
    const lifted=[];
    const moduleExports=[];
    let inlineCount=0;
    let encrypted=false;

    if(moduleServer) {
      removeDirective(ast.program,'use server');
      for(const statement of program.get('body')) {
        if(statement.isExportAllDeclaration()) {
          if(statement.node.exportKind==='type') { statement.remove(); continue; }
          throw new Error(`Server Action wildcard exports must be resolved by the build graph (${file}).`);
        }
        if(statement.isExportDefaultDeclaration()) {
          const declaration=statement.node.declaration;
          const name=program.scope.generateUidIdentifier('defaultAction');
          if(t.isFunctionDeclaration(declaration)) {
            if(!declaration.async||declaration.generator) throw new Error(`Server Action default export must be an async function (${file}).`);
            declaration.id ||= name;
            moduleExports.push({name:'default',local:declaration.id.name});
            statement.replaceWith(declaration);
          } else {
            if(t.isFunction(declaration)&&(!declaration.async||declaration.generator)) throw new Error(`Server Action default export must be an async function (${file}).`);
            statement.replaceWith(t.variableDeclaration('const',[t.variableDeclarator(name,declaration)]));
            moduleExports.push({name:'default',local:name.name});
          }
        } else if(statement.isExportNamedDeclaration()) {
          if(statement.node.exportKind==='type') continue;
          const declaration=statement.node.declaration;
          if(declaration) {
            if(t.isTSInterfaceDeclaration(declaration)||t.isTSTypeAliasDeclaration(declaration)||declaration.declare) continue;
            for(const name of Object.keys(t.getOuterBindingIdentifiers(declaration))) moduleExports.push({name,local:name});
            statement.replaceWith(declaration);
          } else {
            const imports=[];
            for(const specifier of statement.node.specifiers) {
              if(specifier.exportKind==='type') continue;
              const name=specifier.exported.name??specifier.exported.value;
              let local=specifier.local?.name;
              if(statement.node.source) {
                const binding=program.scope.generateUidIdentifier('importedAction');
                imports.push(t.importSpecifier(binding,t.cloneNode(specifier.local)));
                local=binding.name;
              }
              if(!local) throw new Error(`Unsupported Server Action export ${name} (${file}).`);
              moduleExports.push({name,local});
            }
            if(imports.length) statement.replaceWith(t.importDeclaration(imports,statement.node.source)); else statement.remove();
          }
        }
      }
      program.scope.crawl();
      for(const item of moduleExports) {
        let binding=program.scope.getBinding(item.local);
        let value;
        const visited=new Set();
        while(binding&&!visited.has(binding)) {
          visited.add(binding);
          value=binding.path.isVariableDeclarator()?binding.path.node.init:binding.path.node;
          if(!t.isIdentifier(value)) break;
          binding=program.scope.getBinding(value.name);
        }
        if(value&&!t.isImportSpecifier(value)&&!t.isImportDefaultSpecifier(value)&&(!t.isFunction(value)||!value.async||value.generator)) throw new Error(`Server Action export '${item.name}' must be an async function (${file}).`);
      }
    }

    traverse(ast,{Function:{exit(functionPath){
      if(!hasDirective(functionPath.node.body,'use server')) return;
      if(moduleClient) throw new Error(`Inline 'use server' functions cannot be defined in a Client Component (${file}); import an action from a module marked 'use server'.`);
      if(!functionPath.node.async||functionPath.node.generator) throw new Error(`Inline Server Actions must be async functions (${file}).`);
      if(functionPath.isObjectMethod()||functionPath.isClassMethod()||functionPath.isClassPrivateMethod()) throw new Error(`Server Actions must be functions, not object or class methods (${file}).`);
      removeDirective(functionPath.node.body,'use server');
      const captures=new Map();
      function capture(reference,name) {
        if(name==='arguments'&&functionPath.isArrowFunctionExpression()) throw new Error(`Inline arrow Server Actions cannot capture arguments (${file}).`);
        const binding=reference.scope.getBinding(name);
        if(!binding||binding.scope===program.scope) return;
        if(binding.path===functionPath||binding.path.node===functionPath.node) return;
        if(binding.scope===functionPath.scope||binding.scope.path.findParent(parent=>parent===functionPath)) return;
        captures.set(name,binding.kind==='const'?'const':'let');
      }
      functionPath.traverse({
        ReferencedIdentifier(reference){ capture(reference,reference.node.name); },
        AssignmentExpression(reference){for(const name of Object.keys(t.getBindingIdentifiers(reference.node.left)))capture(reference,name);},
        UpdateExpression(reference){if(t.isIdentifier(reference.node.argument))capture(reference,reference.node.argument.name);},
        ThisExpression(reference){ if(functionPath.isArrowFunctionExpression()) throw new Error(`Inline arrow Server Actions cannot capture this (${file}).`); },
      });
      const names=[...captures.keys()];
      const exported=program.scope.generateUidIdentifier('inlineAction');
      const id=register(file,`inline:${functionPath.node.start}:${inlineCount++}`,exported.name);
      const args=program.scope.generateUidIdentifier('actionArgs');
      const cipher=program.scope.generateUidIdentifier('encryptedClosure');
      const original=t.cloneNode(functionPath.node,true);
      if(t.isFunctionDeclaration(original)) original.type='FunctionExpression';
      const body=[];
      if(names.length) {
        encrypted=true;
        const values=program.scope.generateUidIdentifier('closureValues');
        body.push(t.variableDeclaration('const',[t.variableDeclarator(values,t.awaitExpression(t.callExpression(decrypt,[t.stringLiteral(id),cipher])))]));
        for(const [index,name] of names.entries()) body.push(t.variableDeclaration(captures.get(name),[t.variableDeclarator(t.identifier(name),t.memberExpression(values,t.numericLiteral(index),true))]));
      }
      body.push(t.returnStatement(t.callExpression(t.memberExpression(original,t.identifier('apply')),[t.unaryExpression('void',t.numericLiteral(0)),args])));
      lifted.push(t.exportNamedDeclaration(t.functionDeclaration(exported,[...(names.length?[cipher]:[]),t.restElement(args)],t.blockStatement(body),false,true)));
      lifted.push(t.expressionStatement(t.callExpression(registration,[exported,t.stringLiteral(id),t.nullLiteral()])));
      function reference(value) {
        const registered=t.callExpression(registration,[value,t.stringLiteral(id),t.nullLiteral()]);
        return names.length?t.callExpression(bind,[registered,t.stringLiteral(id),t.arrowFunctionExpression([],t.arrayExpression(names.map(name=>t.identifier(name))))]):registered;
      }
      if(functionPath.isFunctionDeclaration()) {
        if(!functionPath.node.id) throw new Error(`Anonymous inline Server Actions must be expressions (${file}).`);
        let parent=functionPath.parentPath;
        if(parent.isExportNamedDeclaration()||parent.isExportDefaultDeclaration()) parent=parent.parentPath;
        if(!parent.isBlockStatement()&&!parent.isProgram()) throw new Error(`Inline Server Action declarations need a block scope (${file}).`);
        parent.unshiftContainer('body',t.expressionStatement(reference(t.cloneNode(functionPath.node.id))));
      } else {
        functionPath.replaceWith(reference(t.cloneNode(functionPath.node,true)));
        functionPath.skip();
      }
    }}});
    const declared=moduleExports.map(item=>({...item,id:register(file,`export:${item.name}`,item.name)}));
    if(!moduleServer&&!inlineCount) { return {server:source,declared:[],inline:false,registrations}; }
    const imports=[t.importDeclaration([t.importSpecifier(registration,t.identifier('registerServerReference'))],t.stringLiteral('react-server-dom-webpack/server.node'))];
    if(encrypted) imports.push(t.importDeclaration([t.importSpecifier(decrypt,t.identifier('decryptBoundArgs')),t.importSpecifier(bind,t.identifier('bindEncryptedReference'))],t.stringLiteral('prnext-internal:action-crypto')));
    ast.program.body.unshift(...imports);
    ast.program.body.push(...lifted);
    // Internal references to exported actions must retain React's server marker
    // and patched bind method too. Keep an existing marker on imported actions;
    // each public alias still has its own stable proxy/manifest registration.
    const registeredLocals=new Set();
    for(const item of declared) {
      if(registeredLocals.has(item.local)) continue;
      registeredLocals.add(item.local);
      ast.program.body.push(t.ifStatement(
        t.binaryExpression('!==',t.memberExpression(t.identifier(item.local),t.identifier('$$typeof')),t.callExpression(t.memberExpression(t.identifier('Symbol'),t.identifier('for')),[t.stringLiteral('react.server.reference')])),
        t.expressionStatement(t.callExpression(registration,[t.identifier(item.local),t.stringLiteral(item.id),t.nullLiteral()]))
      ));
    }
    for(const item of declared) {
      const exported=program.scope.generateUidIdentifier('serverAction');
      const args=program.scope.generateUidIdentifier('args');
      const wrapper=t.arrowFunctionExpression([t.restElement(args)],t.callExpression(t.identifier(item.local),[t.spreadElement(args)]),true);
      ast.program.body.push(t.variableDeclaration('const',[t.variableDeclarator(exported,t.callExpression(registration,[wrapper,t.stringLiteral(item.id),t.nullLiteral()]))]));
      ast.program.body.push(t.exportNamedDeclaration(null,[t.exportSpecifier(exported,t.stringLiteral(item.name))]));
    }
    const result={server:generateMapped(generate,ast,{comments:true},source,file),declared,inline:inlineCount>0,moduleServer,registrations};
    return result;
  }

  return {
    actions, actionKey,
    transform(source,file,mode) {
      if(!source.includes('use server')) return source;
      const result=analyze(source,file);
      if(mode==='rsc') return result.server;
      if(result.moduleServer) return `import {createServerReference} from 'prnext-internal:action-${mode==='browser'?'client':'ssr'}';\n`+result.declared.map((item,index)=>`const action${index}=createServerReference(${JSON.stringify(item.id)});export {action${index} as ${JSON.stringify(item.name)}};`).join('\n');
      if(result.inline) throw new Error(`Inline Server Actions cannot be imported into the client graph (${file}); move the action to a module marked 'use server'.`);
      return source;
    },
  };
}
