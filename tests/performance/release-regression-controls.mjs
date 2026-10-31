import path from 'node:path';
import {readFile} from 'node:fs/promises';

const posix=path.posix;
const MAX_ANCESTORS=256;
const unknown=reason=>({state:'unknown',reason});
const hidden='Cgroup or mount namespaces may hide additional ancestor limits; visible files alone do not prove the host-effective ceiling.';
function absolute(value){
  return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..')&&posix.normalize(value)===value;
}
const under=(root,file)=>root==='/'||file===root||file.startsWith(root+'/');
const unescape=value=>value.replace(/\\([0-7]{3})/g,(_,digits)=>String.fromCharCode(parseInt(digits,8)));

/** Map namespace-visible membership through the actual cgroup2 mount root. */
export function mapCgroupV2Hierarchy(cgroup,mountinfo){
  if(typeof cgroup!=='string'||typeof mountinfo!=='string'||cgroup.length>65536||mountinfo.length>1024*1024)return unknown('Cgroup membership or mount information is unavailable or exceeds its budget.');
  const memberships=cgroup.split('\n').filter(line=>line.startsWith('0::')).map(line=>line.slice(3));
  if(memberships.length!==1||!absolute(memberships[0]))return unknown('A single canonical cgroup-v2 membership could not be established.');
  const membership=memberships[0],mounts=[];
  for(const line of mountinfo.split('\n')){
    const separator=line.indexOf(' - ');if(separator<0)continue;
    const fields=line.slice(0,separator).split(' '),filesystem=line.slice(separator+3).split(' ');
    if(fields.length<6||filesystem[0]!=='cgroup2')continue;
    const root=unescape(fields[3]),mountPoint=unescape(fields[4]);
    if(absolute(root)&&absolute(mountPoint)&&under(root,membership))mounts.push({root,mountPoint});
  }
  // Prefer the mount exposing the most ancestors, not a nested delegation.
  mounts.sort((a,b)=>a.root.length-b.root.length||a.mountPoint.length-b.mountPoint.length||a.mountPoint.localeCompare(b.mountPoint));
  const mount=mounts[0];if(!mount)return unknown('No cgroup-v2 mount maps the observed membership.');
  const directories=[];let current=membership;
  for(;;){
    if(directories.length>=MAX_ANCESTORS)return unknown('Visible cgroup ancestry exceeds the observation budget.');
    const suffix=posix.relative(mount.root,current),mountPath=posix.join(mount.mountPoint,suffix);
    if(!under(mount.mountPoint,mountPath))return unknown('Cgroup membership escapes its mount.');
    directories.push({cgroup:current,mountPath});
    if(current===mount.root)break;
    const parent=posix.dirname(current);if(parent===current||!under(mount.root,parent))return unknown('Visible cgroup ancestry is incomplete.');current=parent;
  }
  return {state:'mapped',membership,mount,directories};
}

function cpu(value){
  if(typeof value!=='string'||value.length>4096)return unknown('cpu.max is unreadable.');
  const raw=value.trim(),match=/^(max|[1-9]\d*)[ \t]+([1-9]\d*)$/.exec(raw);
  if(!match||match[1].length>20||match[2].length>20)return unknown('cpu.max is malformed.');
  return {state:'verified',raw,quotaMicros:match[1]==='max'?null:match[1],periodMicros:match[2]};
}
function memory(value){
  if(typeof value!=='string'||value.length>4096)return unknown('memory.max is unreadable.');
  const raw=value.trim();
  if(raw!=='max'&&!/^(?:0|[1-9]\d{0,19})$/.test(raw))return unknown('memory.max is malformed.');
  return {state:'verified',raw,bytes:raw==='max'?null:raw};
}

/** Pure snapshot parser. Retain every visible ancestor for before/after gates. */
export function parseLinuxResourceControls({status,cgroup,mountinfo,files={}}){
  const allowed=typeof status==='string'?status.match(/^Cpus_allowed_list:\s*([\d,-]+)\s*$/m)?.[1]:undefined;
  const affinity=allowed?{state:'verified',cpus:allowed}:unknown('Kernel CPU affinity is unavailable.');
  const hierarchy=mapCgroupV2Hierarchy(cgroup,mountinfo);
  if(hierarchy.state!=='mapped')return {platform:'linux',affinity,quota:hierarchy,memoryLimit:hierarchy,scope:'No resource limits are imposed by this harness. Inherited cgroup limits could not be established.'};
  const cpuAncestors=[],memoryAncestors=[];let tightestCpu,tightestMemory;
  for(const directory of hierarchy.directories){
    const quota=cpu(files[posix.join(directory.mountPath,'cpu.max')]),limit=memory(files[posix.join(directory.mountPath,'memory.max')]);
    cpuAncestors.push({cgroup:directory.cgroup,...quota});memoryAncestors.push({cgroup:directory.cgroup,...limit});
    if(quota.state==='verified'&&quota.quotaMicros!==null&&(!tightestCpu||BigInt(quota.quotaMicros)*BigInt(tightestCpu.periodMicros)<BigInt(tightestCpu.quotaMicros)*BigInt(quota.periodMicros)))tightestCpu={cgroup:directory.cgroup,...quota};
    if(limit.state==='verified'&&limit.bytes!==null&&(!tightestMemory||BigInt(limit.bytes)<BigInt(tightestMemory.bytes)))tightestMemory={cgroup:directory.cgroup,...limit};
  }
  const visibility={membership:hierarchy.membership,mount:hierarchy.mount};
  return {platform:'linux',affinity,
    quota:{state:'unknown',reason:hidden,visibility,visible:{state:cpuAncestors.every(item=>item.state==='verified')?'observed':'partial',ceilingCpus:tightestCpu?Number(tightestCpu.quotaMicros)/Number(tightestCpu.periodMicros):null,limitingCgroup:tightestCpu?.cgroup||null,ancestors:cpuAncestors}},
    memoryLimit:{state:'unknown',reason:hidden,visibility,visible:{state:memoryAncestors.every(item=>item.state==='verified')?'observed':'partial',ceilingBytes:tightestMemory?.bytes??null,limitingCgroup:tightestMemory?.cgroup||null,ancestors:memoryAncestors}},
    scope:'Kernel CPU affinity and all accessible cgroup-v2 ancestor files are observed. Host-effective cgroup ceilings remain unknown because namespace visibility is not proven. No limits are imposed by this harness.'};
}

export async function observeResourceControls(pid=process.pid){
  if(process.platform!=='linux')return {platform:process.platform,affinity:{state:'not-verified'},quota:{state:'not-imposed'},memoryLimit:{state:'not-verified'},scope:'This harness imposes no quota or CPU affinity. Windows Job limits and macOS resource limits are not inferred from processor count.'};
  const read=async file=>{try{return await readFile(file,'utf8');}catch{return undefined;}};
  const [status,cgroup,mountinfo]=await Promise.all([read(`/proc/${pid}/status`),read(`/proc/${pid}/cgroup`),read(`/proc/${pid}/mountinfo`)]);
  const hierarchy=mapCgroupV2Hierarchy(cgroup,mountinfo),files={};
  if(hierarchy.state==='mapped')for(const directory of hierarchy.directories)for(const name of ['cpu.max','memory.max']){
    const logical=posix.join(directory.mountPath,name);
    // A descendant can have its own mount namespace. Read through its proc root
    // while keeping PID-specific paths out of comparable report provenance.
    files[logical]=await read(`/proc/${pid}/root${logical}`);
  }
  return parseLinuxResourceControls({status,cgroup,mountinfo,files});
}
