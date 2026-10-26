import path from 'node:path';
export function recordDevDependencies(state,options,result){
  if(!state?.dev||!result.metafile)return;
  state.devDependencies||=new Map();state.devStyleBundles||=new Map();state.devStyleDependencies||=new Map();
  const absolute=name=>path.resolve(options.absWorkingDir||state.root,name.replace(/^[\w-]+:(?=(?:[A-Za-z]:[\\/]|\/))/ ,''));
  for(const [name,input]of Object.entries(result.metafile.inputs)){
    const file=absolute(name),imports=state.devDependencies.get(file)||new Set();
    for(const item of input.imports||[])if(!item.external)imports.add(absolute(item.path));
    state.devDependencies.set(file,imports);
  }
  for(const [name,output]of Object.entries(result.metafile.outputs))if(name.endsWith('.css')){
    const inputs=Object.keys(output.inputs||{}).filter(file=>file!=='<stdin>'),imported=new Set();
    for(const input of inputs)for(const item of result.metafile.inputs[input]?.imports||[])if(item.kind==='import-rule')imported.add(item.path);
    const roots=inputs.filter(input=>!imported.has(input));
    state.devStyleBundles.set(path.basename(name),roots.map(file=>file.startsWith('prnext-compiled-css:')?file:path.isAbsolute(file)?file:path.resolve(state.root,file)));
    state.devStyleDependencies.set(path.basename(name),inputs.map(absolute));
  }
}
export function developmentDependencies(state,project,manifest){
  const graph=state?.devDependencies||new Map(),routes=[];
  let bytes=0;
  for(const route of manifest.routes.filter(route=>!route.internal)){
    const source=project.routes.find(item=>item.id===route.id);if(!source)continue;
    const pending=[],seen=new Set(),visit=value=>{if(typeof value==='string'&&path.isAbsolute(value))pending.push(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
    visit(source);if(project.app)pending.push(project.app);if(project.document)pending.push(project.document);
    while(pending.length){const file=pending.pop();if(seen.has(file))continue;seen.add(file);for(const dependency of graph.get(file)||[])pending.push(dependency);}
    const record={route:route.pattern,files:[...seen].filter(file=>file.startsWith(project.root+path.sep)&&!path.relative(project.root,file).startsWith('.prnext-')).map(file=>path.relative(project.root,file).replaceAll(path.sep,'/')).filter(file=>!file.includes(':')&&!file.includes('?'))};
    bytes+=Buffer.byteLength(JSON.stringify(record));if(bytes>16*1024*1024||routes.length>=50000)return Object.assign([],{incomplete:'Route dependency graph exceeds the 16 MiB / 50,000 record budget'});
    routes.push(record);
  }
  return routes;
}
export const developmentStylePlans=state=>[...(state?.devStyleBundles||[])];
export const developmentStyleDependencies=state=>[...(state?.devStyleDependencies||[])];
export function developmentModules(state,root){
  const records=[];let bytes=0;
  const relative=file=>{const name=path.relative(root,file).replaceAll(path.sep,'/');return !name||name.startsWith('../')||name.includes(':')||name.includes('?')||name.startsWith('.prnext-')||name.startsWith('node_modules/')?undefined:name;};
  for(const[file,dependencies]of state?.devDependencies||[]){
    const name=relative(file);if(!name)continue;
    const record={route:name,module:true,files:[name,...[...dependencies].map(relative).filter(Boolean)]};
    bytes+=Buffer.byteLength(JSON.stringify(record));if(bytes>16*1024*1024||records.length>=50000)return Object.assign([],{incomplete:'Module dependency graph exceeds the 16 MiB / 50,000 record budget'});records.push(record);
  }
  return records;
}
