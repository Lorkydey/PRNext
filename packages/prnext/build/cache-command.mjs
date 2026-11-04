import path from 'node:path';
import {inspectCompilationStorage,pruneCompilationStorage,validateCompilationCache} from './compilation-storage.mjs';

export async function cacheCommand(args){
  if(args.length===1&&['--help','-h'].includes(args[0])){
    console.log('prnext cache [directory] [--json]\nprnext cache [directory] --prune [--dry-run] [--max-bytes N] [--json]\n\nInspect compiler caches without executing application config. The budget comes\nfrom the last build (default 256 MiB). --max-bytes overrides this purge only.\nRuntime data, SQLite, page/image caches and application files are excluded.\nStop development before purging. Active worker caches remain pinned.');return;
  }
  let directory,prune=false,dryRun=false,json=false,maxDiskSize;
  const seen=new Set();
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg.startsWith('--')){if(seen.has(arg))throw Error(`Duplicate cache option: ${arg}`);seen.add(arg);}
    if(arg==='--prune')prune=true;
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--json')json=true;
    else if(arg==='--max-bytes'){
      const value=args[++i];if(!/^\d+$/.test(value||''))throw Error('--max-bytes requires a byte count from 0 to 4294967296.');
      maxDiskSize=validateCompilationCache({maxDiskSize:Number(value)}).maxDiskSize;
    }else if(arg.startsWith('-')||directory!==undefined)throw Error('cache accepts one directory, --prune, --dry-run, --max-bytes N and --json.');
    else directory=arg;
  }
  if((dryRun||maxDiskSize!==undefined)&&!prune)throw Error('--dry-run and --max-bytes require --prune.');
  const root=path.resolve(directory||'.');
  const report=prune?await pruneCompilationStorage(root,{maxDiskSize,dryRun}):await inspectCompilationStorage(root);
  if(json){console.log(JSON.stringify(report,null,2));return;}
  const size=value=>(value/1024/1024).toFixed(2)+' MiB';
  console.log(`Compilation caches: ${size(report.bytes)} / ${size(report.maxDiskSize)}`);
  for(const category of report.categories)console.log(`  ${category.name}: ${size(category.bytes)}, ${category.files} files${category.pinned?' (active worker)':''}`);
  if(prune)console.log(report.deferred?report.reason:`${dryRun?'Would reclaim':'Reclaimed'} ${size(report.removedBytes)} in ${report.removedFiles} files; ${size(report.afterBytes)} retained.${report.overBudget?' Active or busy files remain above the budget.':''}`);
  else if(!report.scanComplete)console.log('The scan limit was reached; totals are a lower bound.');
}
