import test from 'node:test';
import assert from 'node:assert/strict';
import {mapCgroupV2Hierarchy,parseLinuxResourceControls,verifyResourcePolicy} from './release-regression-controls.mjs';

const mount=(root='/',point='/sys/fs/cgroup')=>`29 23 0:26 ${root} ${point} rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n`;
test('resource policy requires exactly observed CPU affinity and visible cgroup limits',()=>{
  const policy={cpuLimit:2,memoryBytes:5*1024**3,affinityCpus:'2,3'};
  const controls={platform:'linux',affinity:{state:'verified',cpus:'2-3'},quota:{visible:{state:'observed',ceilingCpus:2}},memoryLimit:{visible:{state:'observed',ceilingBytes:String(5*1024**3)}}};
  assert.equal(verifyResourcePolicy(policy,controls).verified,true);
  assert.equal(verifyResourcePolicy(undefined,controls).verified,false);
  for(const mutate of [value=>{value.affinity.cpus='1-3';},value=>{value.quota.visible.ceilingCpus=null;},value=>{value.memoryLimit.visible.state='partial';},value=>{value.platform='win32';}]){const copy=structuredClone(controls);mutate(copy);assert.throws(()=>verifyResourcePolicy(policy,copy));}
  for(const affinityCpus of ['0-99999999','3-2','0;echo',''])assert.throws(()=>verifyResourcePolicy({...policy,affinityCpus},controls));
});
function snapshot(){return {status:'Name:\tbenchmark\nCpus_allowed_list:\t2-3\n',cgroup:'0::/jobs/release\n',mountinfo:mount(),files:{
  '/sys/fs/cgroup/jobs/release/cpu.max':'max 100000\n','/sys/fs/cgroup/jobs/release/memory.max':'max\n',
  '/sys/fs/cgroup/jobs/cpu.max':'50000 100000\n','/sys/fs/cgroup/jobs/memory.max':'1073741824\n',
  '/sys/fs/cgroup/cpu.max':'max 100000\n','/sys/fs/cgroup/memory.max':'max\n',
}};}

function hostRootSnapshot(){
  const value=snapshot();
  value.files['/sys/fs/cgroup/jobs/release/cpu.max']='200000 100000\n';
  value.files['/sys/fs/cgroup/jobs/release/memory.max']=String(5*1024**3)+'\n';
  value.files['/sys/fs/cgroup/jobs/cpu.max']='max 100000\n';
  value.files['/sys/fs/cgroup/jobs/memory.max']='max\n';
  value.files['/sys/fs/cgroup/cgroup.controllers']='cpuset cpu io memory hugetlb pids\n';
  value.fileErrors={};
  for(const name of ['cpu.max','memory.max','cgroup.type','cgroup.events']){
    const file='/sys/fs/cgroup/'+name;delete value.files[file];value.fileErrors[file]='ENOENT';
  }
  return value;
}

test('a kernel hierarchy root without non-root limit interfaces preserves the controlled systemd leaf',()=>{
  const parsed=parseLinuxResourceControls(hostRootSnapshot());
  assert.equal(parsed.quota.visible.state,'observed');
  assert.equal(parsed.memoryLimit.visible.state,'observed');
  assert.deepEqual(parsed.quota.visible.ancestors.at(-1),{cgroup:'/',state:'verified',raw:null,quotaMicros:null,periodMicros:null,source:'kernel-hierarchy-root'});
  assert.deepEqual(parsed.memoryLimit.visible.ancestors.at(-1),{cgroup:'/',state:'verified',raw:null,bytes:null,source:'kernel-hierarchy-root'});
  assert.equal(verifyResourcePolicy({cpuLimit:2,memoryBytes:5*1024**3,affinityCpus:'2,3'},parsed).verified,true);
  assert.equal(parsed.quota.state,'unknown');assert.match(parsed.quota.reason,/namespaces may hide/);
});

test('a delegated namespace root is not promoted to a kernel root when its limit files are absent',()=>{
  const namespace=hostRootSnapshot();
  namespace.files['/sys/fs/cgroup/cgroup.type']='domain\n';
  namespace.files['/sys/fs/cgroup/cgroup.events']='populated 1\nfrozen 0\n';
  delete namespace.fileErrors['/sys/fs/cgroup/cgroup.type'];delete namespace.fileErrors['/sys/fs/cgroup/cgroup.events'];
  const parsed=parseLinuxResourceControls(namespace);
  assert.equal(parsed.quota.visible.state,'partial');assert.equal(parsed.memoryLimit.visible.state,'partial');
  assert.throws(()=>verifyResourcePolicy({cpuLimit:2,memoryBytes:5*1024**3,affinityCpus:'2,3'},parsed));
  const cropped=hostRootSnapshot();cropped.mountinfo=mount('/jobs','/sys/fs/cgroup/jobs');
  const hidden=parseLinuxResourceControls(cropped);
  assert.equal(hidden.quota.visible.ancestors.at(-1).cgroup,'/jobs');
  assert.equal(hidden.quota.state,'unknown');
  // Even explicit missing interfaces on this cropped mount do not prove root.
  for(const name of ['cpu.max','memory.max','cgroup.type','cgroup.events']){
    const file='/sys/fs/cgroup/jobs/'+name;delete cropped.files[file];cropped.fileErrors[file]='ENOENT';
  }
  cropped.files['/sys/fs/cgroup/jobs/cgroup.controllers']='cpu memory\n';
  assert.equal(parseLinuxResourceControls(cropped).quota.visible.state,'partial');
});

test('root identity requires explicit ENOENT, readable controller metadata and complete non-root ancestry',()=>{
  for(const name of ['cgroup.type','cgroup.events'])for(const code of ['EACCES','ENOTDIR',undefined]){
    const value=hostRootSnapshot();value.fileErrors['/sys/fs/cgroup/'+name]=code;
    assert.equal(parseLinuxResourceControls(value).quota.visible.state,'partial');
  }
  for(const name of ['cpu.max','memory.max']){
    const value=hostRootSnapshot();value.fileErrors['/sys/fs/cgroup/'+name]='EACCES';
    assert.equal(parseLinuxResourceControls(value)[name==='cpu.max'?'quota':'memoryLimit'].visible.state,'partial');
  }
  for(const controllers of [undefined,'pids io\n','cpu memory\0','x'.repeat(4097)]){
    const value=hostRootSnapshot();value.files['/sys/fs/cgroup/cgroup.controllers']=controllers;
    assert.equal(parseLinuxResourceControls(value).memoryLimit.visible.state,'partial');
  }
  const missingParent=hostRootSnapshot();delete missingParent.files['/sys/fs/cgroup/jobs/cpu.max'];missingParent.fileErrors['/sys/fs/cgroup/jobs/cpu.max']='ENOENT';
  assert.equal(parseLinuxResourceControls(missingParent).quota.visible.state,'partial');
});

test('an unlimited leaf retains tighter CPU and memory constraints from all visible parents',()=>{
  const parsed=parseLinuxResourceControls(snapshot());
  assert.deepEqual(parsed.affinity,{state:'verified',cpus:'2-3'});
  assert.equal(parsed.quota.visible.ceilingCpus,0.5);assert.equal(parsed.quota.visible.limitingCgroup,'/jobs');
  assert.equal(parsed.memoryLimit.visible.ceilingBytes,'1073741824');assert.equal(parsed.memoryLimit.visible.limitingCgroup,'/jobs');
  assert.deepEqual(parsed.quota.visible.ancestors.map(value=>value.cgroup),['/jobs/release','/jobs','/']);
  assert.equal(parsed.quota.state,'unknown');assert.match(parsed.quota.reason,/namespaces may hide/);
});

test('changing only an ancestor ceiling changes comparable before/after provenance',()=>{
  const first=snapshot(),next=structuredClone(first);
  next.files['/sys/fs/cgroup/jobs/cpu.max']='25000 100000';
  next.files['/sys/fs/cgroup/jobs/memory.max']='536870912';
  const before=parseLinuxResourceControls(first),after=parseLinuxResourceControls(next);
  assert.notDeepEqual(before,after);assert.equal(after.quota.visible.ceilingCpus,0.25);assert.equal(after.memoryLimit.visible.ceilingBytes,'536870912');
});

test('non-root cgroup mounts map relative membership and explicitly preserve hidden-ancestor uncertainty',()=>{
  const source={...snapshot(),mountinfo:mount('/jobs','/delegated'),files:{'/delegated/release/cpu.max':'max 100000','/delegated/release/memory.max':'max','/delegated/cpu.max':'100000 200000','/delegated/memory.max':'2147483648'}};
  const mapped=mapCgroupV2Hierarchy(source.cgroup,source.mountinfo);
  assert.deepEqual(mapped.directories,[{cgroup:'/jobs/release',mountPath:'/delegated/release'},{cgroup:'/jobs',mountPath:'/delegated'}]);
  const parsed=parseLinuxResourceControls(source);assert.equal(parsed.quota.visible.ceilingCpus,0.5);assert.equal(parsed.quota.state,'unknown');
  assert.equal(parsed.memoryLimit.visible.ceilingBytes,'2147483648');assert.equal(parsed.memoryLimit.state,'unknown');
});

test('mount escapes, visible root choices, unavailable controllers and malformed data remain honest',()=>{
  const escaped=mapCgroupV2Hierarchy('0::/jobs/release',mount('/jobs','/delegated\\040space'));
  assert.equal(escaped.directories[0].mountPath,'/delegated space/release');
  const broad=mapCgroupV2Hierarchy('0::/jobs/release',mount('/jobs','/limited')+mount('/','/host'));
  assert.equal(broad.mount.root,'/');assert.equal(broad.directories.at(-1).mountPath,'/host');
  for(const cgroup of ['0::/../../outside','0::relative','0::/jobs\n0::/other'])assert.equal(mapCgroupV2Hierarchy(cgroup,mount()).state,'unknown');
  const missing=snapshot();delete missing.files['/sys/fs/cgroup/jobs/cpu.max'];
  const parsed=parseLinuxResourceControls(missing);assert.equal(parsed.quota.visible.state,'partial');assert.equal(parsed.quota.state,'unknown');
  const malformed=snapshot();malformed.files['/sys/fs/cgroup/jobs/cpu.max']='-1 0';malformed.files['/sys/fs/cgroup/jobs/memory.max']='not-a-limit';
  const invalid=parseLinuxResourceControls(malformed);assert.equal(invalid.quota.visible.ancestors[1].state,'unknown');assert.equal(invalid.memoryLimit.visible.ancestors[1].state,'unknown');
  assert.equal(parseLinuxResourceControls({...snapshot(),mountinfo:''}).quota.state,'unknown');
});
