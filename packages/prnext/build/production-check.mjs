import {isIP} from 'node:net';

/** Configuration checks only: external proxies, databases and sessions need live tests. */
export function productionDiagnostics(config,project,{env=process.env}={}){
  const diagnostics=[];
  const locations={'production-static':'output','production-origin':'server.publicOrigin','production-origin-https':'server.publicOrigin','production-proxy':'server.trustedProxies','production-proxy-range':'server.trustedProxies','production-auth-cookies':'navigationCache.authCookies','production-action-origins':'experimental.serverActions.allowedOrigins','production-source-maps':'productionBrowserSourceMaps'};
  const add=(id,severity,message,action,location)=>diagnostics.push({id,code:id,path:location||locations[id]||'production',severity,message,...(action?{action}:{})});
  if(config.output==='export'){
    add('production-static','info','Static export does not run the PRNext HTTP server.','Check HTTPS, headers and health checks at the static host.');
  }else{
    const origin=config.server?.publicOrigin;
    if(!origin)add('production-origin','warning','The public server origin is not configured.','Set server.publicOrigin to the public HTTPS origin used by redirects, authentication callbacks and request URLs.');
    else{
      const url=new URL(origin),hostname=url.hostname,loopback=hostname==='localhost'||hostname==='[::1]'||(isIP(hostname)===4&&hostname.startsWith('127.'));
      if(url.protocol!=='https:'&&!loopback)add('production-origin-https','warning','The public server origin uses HTTP.','Use an HTTPS public origin and test secure cookies and authentication callbacks through the real proxy.');
      else add('production-origin','info','The public server origin is configured.');
    }
    if(config.server?.trustedProxies?.length)add('production-proxy','info','Forwarded host and protocol are accepted only from the configured proxy addresses.','Bind the application to the private interface and configure the proxy to replace forwarded headers.');
    if(config.server?.trustedProxies?.some(value=>/\/0$/.test(value)))add('production-proxy-range','error','A trusted proxy range includes every remote address.','Replace /0 ranges with the exact proxy IP addresses or private CIDRs.');
  }
  if(project?.routes.some(route=>route.router==='app')&&config.output!=='export'){
    if(config.navigationCache?.maxEntries>0&&!config.navigationCache?.authCookies?.length)add('production-auth-cookies','warning','Retained App pages have no explicit authentication cookie names.','For authenticated applications, set navigationCache.authCookies to the exact session cookie names, including secure variants. Test account A → sign out → account B without retaining private drafts.');
    else if(config.navigationCache?.authCookies?.length)add('production-auth-cookies','info','Authentication cookie changes enable strict retained-page state resets.','Test account A → sign out → account B in the browser; this check does not verify application session behavior.');
    if(config.experimental?.serverActions?.allowedOrigins?.some(value=>value.includes('*')))add('production-action-origins','warning','Server Actions allow wildcard origin patterns.','Use the narrowest trusted host patterns and test rejected cross-origin mutations.');
  }
  const experiments=['nextScriptWorkers','lazyDynamicImports','streamingRequestBodies','nativePprShell','parallelBuilds','presentationComponents'].filter(key=>config.experimental?.[key]);
  if(config.reactCompiler?.backend==='oxc')experiments.push('reactCompiler.backend=oxc');
  if(config.partialPrefetching)experiments.push('partialPrefetching');
  if(env.PRNEXT_SSR_STREAM==='node')experiments.push('PRNEXT_SSR_STREAM=node');
  for(const option of experiments)add('production-experimental','warning',`Experimental option enabled: ${option}.`,'Qualify this exact option on the deployment workload and keep its documented fallback available.',option.includes('=')?option.split('=')[0]:option==='partialPrefetching'?option:'experimental.'+option);
  if(config.productionBrowserSourceMaps)add('production-source-maps','warning','Production browser source maps are enabled.','Confirm that exposing original browser sources is intentional.');
  add('production-validation','info','Configuration preflight does not prove production readiness.','Build the final artifact, test public HTTPS, account changes, health checks, rollback and application dependencies before switching traffic.');
  return diagnostics;
}
