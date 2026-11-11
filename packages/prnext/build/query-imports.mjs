// Query's ESM and CommonJS entries own different React contexts. Framework
// adapters and application hooks must resolve to one entry in each graph.
// No package is loaded or resolved unless the application imports Query.
export function queryImports(esbuild,{browser,projectRoot}) {
  esbuild.onResolve({filter:/^@tanstack\/react-query$/},async args=>{
    if(args.pluginData?.prnextQueryEntry)return;
    if(!browser)return args.namespace==='prnext-query-common'
      ?{path:args.path,external:true}:{path:args.path,namespace:'prnext-query-common'};
    return esbuild.resolve(args.path,{resolveDir:projectRoot,kind:'import-statement',pluginData:{prnextQueryEntry:true}});
  });
  esbuild.onLoad({filter:/.*/,namespace:'prnext-query-common'},()=>({loader:'js',contents:"module.exports=require('@tanstack/react-query');"}));
}
