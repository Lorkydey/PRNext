const phases = ['rsc', 'ssr'];
const outcomes = ['completed', 'failed', 'cancelled', 'timedOut'];
const bytes = value => Number.isSafeInteger(value) && value >= 0 && value <= 32 * 1024 * 1024;
const duration = value => Number.isFinite(value) && value >= 0 && value <= 86400000;
const quantile = (values, q) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1] : null;

// A route pattern is supplied by the framework, never inferred from a URL.
// Copy only this schema from disk; old/corrupted/foreign diagnostic events cannot
// contribute arbitrary properties, unbounded groups or non-finite metrics.
export function flightSamples(events) {
  return events.filter(event => event?.type === 'flight' && phases.includes(event.phase) && outcomes.includes(event.outcome) &&
    typeof event.route === 'string' && event.route.length <= 256 && !/[\0\r\n]/.test(event.route) &&
    Number.isSafeInteger(event.time) && event.time >= 0 && event.time <= 18446744073709 &&
    bytes(event.flightBytes) && bytes(event.flightChunks) && bytes(event.responseBytes) && bytes(event.peakQueuedBytes) && duration(event.durationMs))
    .slice(-10000).map(event => ({type:'flight',route:event.route,phase:event.phase,outcome:event.outcome,time:event.time,
      method:/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(event.method)?event.method:'_OTHER',
      durationMs:event.durationMs,flightBytes:event.flightBytes,flightChunks:event.flightChunks,responseBytes:event.responseBytes,peakQueuedBytes:event.peakQueuedBytes,
      ...Object.fromEntries(['firstChunkMs','modelReadyMs','shellReadyMs'].filter(key=>duration(event[key])).map(key=>[key,event[key]])),
      ...(['direct','normalized'].includes(event.ppr)?{ppr:event.ppr}:{})}));
}

export function summarizeFlight(events) {
  const groups = new Map(), sample = flightSamples(events);
  for (const event of sample) {
    const key = JSON.stringify([event.route,event.phase]);
    if (!groups.has(key)) {
      if (groups.size >= 256) continue;
      groups.set(key,{route:event.route,phase:event.phase,events:[]});
    }
    groups.get(key).events.push(event);
  }
  const routes = [...groups.values()].map(({events,...group})=>{
    const completed=events.filter(event=>event.outcome==='completed');
    const p95=key=>quantile(completed.map(event=>event[key]).filter(value=>Number.isFinite(value)),.95);
    return {...group,samples:events.length,...Object.fromEntries(outcomes.map(outcome=>[outcome,events.filter(event=>event.outcome===outcome).length])),
      flightP50Bytes:quantile(completed.map(event=>event.flightBytes),.5),flightP95Bytes:p95('flightBytes'),
      responseP95Bytes:p95('responseBytes'),durationP95Ms:p95('durationMs'),firstChunkP95Ms:p95('firstChunkMs'),
      modelReadyP95Ms:p95('modelReadyMs'),shellReadyP95Ms:p95('shellReadyMs'),
      peakQueuedBytes:events.reduce((max,event)=>Math.max(max,event.peakQueuedBytes),0),
      directPprSamples:events.filter(event=>event.ppr==='direct').length,normalizedPprSamples:events.filter(event=>event.ppr==='normalized').length};
  }).sort((a,b)=>(b.flightP95Bytes??-1)-(a.flightP95Bytes??-1)||a.route.localeCompare(b.route)||a.phase.localeCompare(b.phase));
  return {flight:routes,flightSample:sample};
}

export function flightMetrics(events) {
  const bounds=[1024,4096,16384,65536,131072,262144,1048576,4194304,16777216],groups=new Map();
  for (const event of flightSamples(events).filter(value=>value.outcome==='completed')) {
    const key=JSON.stringify([event.route,event.phase]);
    if(!groups.has(key)){
      if(groups.size>=256)continue;
      groups.set(key,{route:event.route,phase:event.phase,start:event.time,end:event.time,values:[]});
    }
    const group=groups.get(key);group.values.push(event.flightBytes);group.start=Math.min(group.start,event.time);group.end=Math.max(group.end,event.time);
  }
  const dataPoints=[...groups.values()].map(group=>{
    const buckets=Array(bounds.length+1).fill(0);
    for(const value of group.values){const index=bounds.findIndex(bound=>value<=bound);buckets[index<0?bounds.length:index]++;}
    return {attributes:[{key:'http.route',value:{stringValue:group.route}},{key:'prnext.render.phase',value:{stringValue:group.phase}}],
      startTimeUnixNano:String(BigInt(group.start)*1000000n),timeUnixNano:String(BigInt(group.end)*1000000n),
      count:String(group.values.length),sum:group.values.reduce((a,b)=>a+b,0),min:Math.min(...group.values),max:Math.max(...group.values),
      explicitBounds:bounds,bucketCounts:buckets.map(String)};
  });
  return {name:'prnext.flight.response.size',description:'Bounded diagnostic sample of uncompressed Flight bytes read to completion. RSC and SSR are separate observations of the same payload; never add their counts. Cancelled/failed samples are excluded.',unit:'By',histogram:{aggregationTemporality:1,dataPoints}};
}
