const quantile = (values, q) => values.length ? Math.round([...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]*100)/100 : null;
const durations = events => events.map(e=>e.durationMs).filter(v=>Number.isFinite(v)&&v>=0);
export function summarizeDiagnostics(events, snapshots = []) {
  const http=events.filter(e=>e.type==='http'), times=durations(http);
  const wake=durations(events.filter(e=>e.type==='wake'&&e.phase==='node-ready'));
  const processes=new Map();
  for(const event of events)if(event.type==='process'&&Number.isSafeInteger(event.pid)&&Number.isFinite(event.rssBytes)&&event.rssBytes>=0)processes.set(event.pid,event);
  const last=snapshots.sort((a,b)=>b.unixMs-a.unixMs)[0];
  const current=last&&Date.now()-last.unixMs<30000&&Date.now()>=last.unixMs;
  const rss=[...processes.values()].filter(e=>Date.now()-e.time<30000&&Date.now()>=e.time);
  const summary={requests:http.length,errors:http.filter(e=>e.status>=500).length,p50Ms:quantile(times,.5),p95Ms:quantile(times,.95),wakeP95Ms:quantile(wake,.95),workerRssBytes:rss.length?rss.reduce((n,e)=>n+e.rssBytes,0):null,
    queuedJobs:current?last.workers.queuedJobs??null:null,activeJobs:current?last.workers.activeJobs??null:null, runtimeSampleAt:last?.unixMs??null};
  const findings=[];
  if(!http.length)findings.push({level:'info',code:'NO_SAMPLE',message:'No HTTP sample recorded.',action:'Start with --inspect, visit the site and run inspect again.'});
  if(summary.queuedJobs>0)findings.push({level:'warning',code:'WORKER_QUEUE',message:`${summary.queuedJobs} jobs are waiting for a worker.`,action:'Check slow routes and available CPU/RAM before increasing concurrency.'});
  if(summary.p95Ms>=1000)findings.push({level:'warning',code:'SLOW_HEADERS',message:'The slowest 5% of recorded responses take at least one second to prepare headers.',action:'Inspect route and fetch timings below; this includes queueing and startup.'});
  if(summary.errors)findings.push({level:'warning',code:'SERVER_ERRORS',message:`${summary.errors} recorded requests returned a server error.`,action:'Check application logs for the same sample period.'});
  if(summary.wakeP95Ms>=1000)findings.push({level:'info',code:'SLOW_WAKE',message:'Recorded worker startup p95 exceeds one second.',action:'Review startup imports or use keep-warm if the extra memory is acceptable.'});
  return {summary,findings,metricSample:http.filter(e=>Number.isFinite(e.durationMs)&&e.durationMs>=0&&e.durationMs<=86400000&&Number.isSafeInteger(e.time)&&e.time>=0&&e.time<=18446744073709).map(e=>({route:typeof e.route==='string'?e.route.slice(0,256):'<unmatched>',method:/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(e.method)?e.method:'_OTHER',durationMs:e.durationMs,time:e.time}))};
}

/** OTLP/JSON Metrics export of a bounded local sample, never a complete traffic counter. */
export function inspectionMetrics(report) {
  const bounds=[.001,.005,.01,.025,.05,.1,.25,.5,1,2.5,5,10], groups=new Map();
  for(const event of report.metricSample||[]) {
    const key=JSON.stringify([event.route,event.method]);
    if(!groups.has(key))groups.set(key,{route:event.route,method:event.method,values:[],start:event.time,end:event.time});
    const group=groups.get(key);group.values.push(event.durationMs/1000);group.start=Math.min(group.start,event.time);group.end=Math.max(group.end,event.time);
  }
  const dataPoints=[...groups.values()].map(group=>{
    const buckets=Array(bounds.length+1).fill(0);
    for(const value of group.values){const index=bounds.findIndex(bound=>value<=bound);buckets[index<0?bounds.length:index]++;}
    return {attributes:[{key:'http.route',value:{stringValue:group.route}},{key:'http.request.method',value:{stringValue:group.method}}],
      startTimeUnixNano:String(BigInt(Math.trunc(group.start))*1000000n),timeUnixNano:String(BigInt(Math.trunc(group.end))*1000000n),count:String(group.values.length),sum:group.values.reduce((a,b)=>a+b,0),min:Math.min(...group.values),max:Math.max(...group.values),explicitBounds:bounds,bucketCounts:buckets.map(String)};
  });
  return {resourceMetrics:[{resource:{attributes:[{key:'service.name',value:{stringValue:'prnext'}},{key:'prnext.inspect.sampled',value:{boolValue:true}}]},scopeMetrics:[{scope:{name:'prnext.inspect',version:'1'},metrics:[{name:'prnext.http.response.headers.duration',description:'Bounded diagnostic sample of time until response headers; excludes response body streaming.',unit:'s',histogram:{aggregationTemporality:1,dataPoints}}]}]}]};
}
