import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMap } from 'node:module';
import { readBuildDirectory } from './build-directory.mjs';

const allowed = /\.(?:[cm]?jsx?|tsx?|css|s[ac]ss|html|mdx?|json)$/i;
const privatePart = /^(?:node_modules|\.git|\.codex|secrets?|credentials?|\.ssh)$/i;
const privateFile = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|(?:credentials|secrets?)(?:[.-].*)?)$/i;
const within = (root, file) => { const relative=path.relative(root,file);return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep); };
const bounded = (value, fallback=1) => Number.isInteger(Number(value))&&Number(value)>0&&Number(value)<=10_000_000?Number(value):fallback;
function locations(args) {
  const found=[];
  const add=(file,line,column)=>{if(typeof file==='string'&&file.length<=4096)found.push({file,line:bounded(line),column:bounded(column)});};
  if(args.file||args.url)add(args.file||args.url,args.line,args.column);
  for(const input of [args.source,args.stack,args.error?.stack,typeof args.error==='string'?args.error:undefined]){
    if(typeof input!=='string')continue;
    for(const line of input.slice(0,128*1024).split('\n').slice(0,80)){
      const match=/(?:\bat\s+(?:.*?\s+\()?|^\s*|\s+)((?:https?:\/\/|file:\/\/\/|[A-Za-z]:[\\/]|\.?\.?[\\/])?[^()\n]+?):(\d+):(\d+)(?:\)?(?:\s|:|$))/.exec(line);
      if(match)add(match[1].trim(),match[2],match[3]);
      else {const ts=/^\s*(.+?)\((\d+),(\d+)\)/.exec(line);if(ts)add(ts[1],ts[2],ts[3]);}
      if(found.length>=24)return found;
    }
  }
  return found;
}

/** Read only bounded source inside this dev project. No shell, HTTP fetch or eval. */
export function createDevSourceTools(projectRoot) {
  const canonical=realpath(projectRoot);
  async function scoped(file,{compiled=false}={}) {
    const root=await canonical;
    if(typeof file!=='string'||/[\x00-\x1f\x7f]/.test(file))throw Error('Source file is not available in this project.');
    const resolved=path.resolve(root,file),relative=path.relative(root,resolved);
    if(!within(root,resolved)||relative.split(/[\\/]/).some(part=>privatePart.test(part)||privateFile.test(part))||!allowed.test(resolved))throw Error('Source file is not available in this project.');
    const dist=compiled?undefined:await readBuildDirectory(root);
    const generated=file=>{const value=path.relative(root,file);return value.split(/[\\/]/).some(part=>part.startsWith('.prnext'))||value===dist||value.startsWith(dist+path.sep);};
    if(!compiled&&generated(resolved))throw Error('Choose an original project source file.');
    const actual=await realpath(resolved);
    if(!within(root,actual)||!compiled&&generated(actual)||path.relative(root,actual).split(/[\\/]/).some(part=>privatePart.test(part)||privateFile.test(part)))throw Error('Source file is not available in this project.');
    const info=await stat(actual);if(!info.isFile()||info.size>1024*1024)throw Error('Source file exceeds the development preview limit.');
    return {root,file:actual,relative:path.relative(root,actual).split(path.sep).join('/')};
  }
  async function mapAsset(location) {
    let pathname=location.file;
    if(/^https?:\/\//.test(pathname)){try{pathname=decodeURIComponent(new URL(pathname).pathname);}catch{return;}}
    const asset=/(?:^|\/)_(?:prnext|next)\/assets\/([^/]+\.m?js)$/.exec(pathname);
    const root=await canonical,dist=await readBuildDirectory(root);
    let logical,original;
    if(asset)logical=path.join(root,dist,'assets',asset[1]);
    else {
      if(pathname.startsWith('file:')){try{pathname=fileURLToPath(pathname);}catch{return;}}
      const generated=path.resolve(root,pathname),relative=path.relative(root,generated).split(path.sep).join('/');
      const suffix=/(?:^|\/)(assets|server|app-ssr|app-ssr-edge|edge)\/([^/]+\.m?js)$/.exec(relative);
      if(!within(root,generated)||!suffix||!(relative.startsWith(dist+'/')||relative.startsWith('.prnext-dev/')))return;
      original=generated;logical=path.join(root,dist,suffix[1],suffix[2]);
    }
    const choices=[...(original?[original]:[]),logical];
    // Source maps refer to the logical build depth even after a generation is
    // copied under .prnext-dev/<session>/<generation> for in-flight requests.
    const home=path.join(root,'.prnext-dev');
    const sessions=await readdir(home,{withFileTypes:true}).catch(()=>[]);
    for(const session of sessions.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).slice(-4)){
      const directory=path.join(home,session.name),generations=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
      const suffix=path.relative(path.join(root,dist),logical);
      for(const generation of generations.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).slice(-8).reverse())choices.push(path.join(directory,generation.name,suffix));
    }
    for(const choice of choices){try{
      const checked=await scoped(choice,{compiled:true});
      const mapFile=await realpath(checked.file+'.map');if(!within(root,mapFile))continue;
      const size=await stat(mapFile);if(size.size>8*1024*1024)continue;
      const payload=JSON.parse(await readFile(mapFile,'utf8'));
      const entry=new SourceMap(payload).findEntry(location.line-1,location.column-1);
      if(!entry?.originalSource)continue;
      const original=entry.originalSource.startsWith('file:')?fileURLToPath(entry.originalSource):path.resolve(path.dirname(logical),payload.sourceRoot||'',entry.originalSource);
      const captured=payload.sourcesContent?.[payload.sources?.indexOf(entry.originalSource)];
      return {...await scoped(original),line:entry.originalLine+1,column:entry.originalColumn+1,mapped:true,...(typeof captured==='string'&&captured.length<=1024*1024?{captured}:{} )};
    }catch{/* Another generation may have retired; try the next retained map. */}}
  }
  async function locate(args) {
    for(const location of locations(args)){
      try {
        const mapped=await mapAsset(location);if(mapped)return mapped;
        let name=location.file;
        if(name.startsWith('file:'))name=fileURLToPath(name);
        if(/^https?:\/\//.test(name))continue;
        return {...await scoped(name),line:location.line,column:location.column,mapped:false};
      } catch {/* Framework and external stack frames are not project source. */}
    }
    throw Error('No original project source was found for this message.');
  }
  async function source(args={}) {
    const found=await locate(args),text=found.captured??await readFile(found.file,'utf8'),lines=text.split(/\r?\n/),line=Math.min(found.line,Math.max(1,lines.length));
    const excerpt=[];for(let current=Math.max(1,line-3);current<=Math.min(lines.length,line+3);current++)excerpt.push({line:current,text:lines[current-1].slice(0,4000)});
    const column=Math.min(found.column,(lines[line-1]?.length||0)+1);
    return {file:found.relative,line,column,mapped:found.mapped,excerpt,frame:excerpt.map(item=>`${item.line===line?'>':' '} ${String(item.line).padStart(4)} | ${item.text}`).join('\n'),editorUrl:editorUrl(found.file,line,column,'vscode')};
  }
  function editorUrl(file,line,column,editor){return `${editor}://file/${file.split(path.sep).map(encodeURIComponent).join('/').replace(/^\//,'')}:${line}:${column}`;}
  async function editor(args={}) {
    const editor=args.editor||'vscode';if(!['vscode','cursor'].includes(editor))throw Error('Choose VS Code or Cursor.');
    const found=await locate(args);return {file:found.relative,line:found.line,column:found.column,editorUrl:editorUrl(found.file,found.line,found.column,editor)};
  }
  return {source,editor};
}
