import {createRequire} from 'node:module';
import path from 'node:path';
const [compiler,filename,cache]=process.argv.slice(2),ts=createRequire(import.meta.url)(compiler);
const format={getCanonicalFileName:name=>name,getCurrentDirectory:()=>path.dirname(filename),getNewLine:()=>ts.sys.newLine};
const send=diagnostics=>{
  let bytes=0;const errors=[];
  for(const diagnostic of diagnostics){if(diagnostic.category!==ts.DiagnosticCategory.Error)continue;const text=ts.formatDiagnostics([diagnostic],format);if(bytes+text.length>20000||errors.length>=40)break;bytes+=text.length;errors.push(text);}
  if(process.connected)process.send({type:'diagnostics',errors});
};
const host=ts.createWatchCompilerHost(filename,{noEmit:true,incremental:true,...(cache?{tsBuildInfoFile:cache}:{})},ts.sys,ts.createSemanticDiagnosticsBuilderProgram,diagnostic=>send([diagnostic]),()=>{});
host.writeFile=(filename,contents)=>{if(cache&&path.resolve(filename)===path.resolve(cache))ts.sys.writeFile(filename,contents);};
host.afterProgramCreate=builder=>{
  try{send(ts.getPreEmitDiagnostics(builder.getProgram()));builder.emit(undefined,host.writeFile);}catch(error){send([{category:ts.DiagnosticCategory.Error,code:0,messageText:error.message}]);}
};
const watcher=ts.createWatchProgram(host);
const close=()=>{watcher.close();process.exit(0);};
process.once('disconnect',close);process.once('SIGTERM',close);process.once('SIGINT',close);
