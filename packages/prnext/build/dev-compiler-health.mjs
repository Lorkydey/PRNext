export function createCompilerHealth({maxRssMb=768,maxHeapMb=384,maxBuilds=256}={}) {
  let builds=0;const samples=[];
  return ({rss,heapUsed})=>{
    builds++;const rssMb=rss/1024/1024,heapMb=heapUsed/1024/1024;
    samples.push(rssMb);if(samples.length>12)samples.shift();
    const floor=Math.min(...samples),growth=rssMb-floor;
    const reason=rssMb>=maxRssMb?'rss-limit':heapMb>=maxHeapMb?'heap-limit':
      samples.length>=8&&growth>128&&rssMb>floor*1.35?'sustained-growth':builds>=maxBuilds?'session-limit':null;
    return {builds,rssMb:Math.round(rssMb),heapMb:Math.round(heapMb),recycle:reason!==null,reason};
  };
}
