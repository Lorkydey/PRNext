"""Read-only closing machine snapshot and Windows physical-core mapping."""
import ctypes,datetime,hashlib,json,pathlib,platform,subprocess,sys
from ctypes import wintypes
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6'
sys.path.insert(0,str(ROOT/'artifacts/performance/python'))
import psutil
psutil.Process().cpu_affinity([0,1])
class InfoData(ctypes.Union):_fields_=[('reserved',ctypes.c_ulonglong*2)]
class Info(ctypes.Structure):_fields_=[('mask',ctypes.c_size_t),('relationship',wintypes.DWORD),('data',InfoData)]
kernel=ctypes.WinDLL('kernel32',use_last_error=True);query=kernel.GetLogicalProcessorInformation
query.argtypes=[ctypes.POINTER(Info),ctypes.POINTER(wintypes.DWORD)];query.restype=wintypes.BOOL
size=wintypes.DWORD();query(None,ctypes.byref(size));assert ctypes.get_last_error()==122
buffer=(Info*(size.value//ctypes.sizeof(Info)))();assert query(buffer,ctypes.byref(size))
cores=[[i for i in range(64) if row.mask&(1<<i)] for row in buffer if row.relationship==0]
cpu=json.loads(subprocess.check_output(['powershell','-NoProfile','-Command','Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors | ConvertTo-Json -Compress'],text=True,creationflags=0x08000000))
assert cores==[[i,i+1] for i in range(0,12,2)],cores
record={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':platform.platform(),'processor':cpu,'physicalCoreLogicalCpus':cores,
        'memory':psutil.virtual_memory()._asdict(),'swap':psutil.swap_memory()._asdict(),
        'swapCaveat':'Windows psutil sin/sout are hardcoded zero, not observed paging I/O. Pagefile configuration was not changed; OS automatic sizing may change size. Snapshots do not measure swap activity throughout the runs.',
        'scriptSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
with (OUT/'environment-final.json').open('x',encoding='utf-8') as output:json.dump(record,output,indent=2)
print(json.dumps({'cores':cores,'memoryTotal':record['memory']['total'],'swap':record['swap']}))
