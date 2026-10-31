import test from 'node:test';
import assert from 'node:assert/strict';
import {mapCgroupV2Hierarchy,parseLinuxResourceControls} from './release-regression-controls.mjs';

const mount=(root='/',point='/sys/fs/cgroup')=>`29 23 0:26 ${root} ${point} rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n`;
function snapshot(){return {status:'Name:\tbenchmark\nCpus_allowed_list:\t2-3\n',cgroup:'0::/jobs/release\n',mountinfo:mount(),files:{
  '/sys/fs/cgroup/jobs/release/cpu.max':'max 100000\n','/sys/fs/cgroup/jobs/release/memory.max':'max\n',
  '/sys/fs/cgroup/jobs/cpu.max':'50000 100000\n','/sys/fs/cgroup/jobs/memory.max':'1073741824\n',
  '/sys/fs/cgroup/cpu.max':'max 100000\n','/sys/fs/cgroup/memory.max':'max\n',
}};}

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
