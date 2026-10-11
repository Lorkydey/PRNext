"""Analyse completed WPT traces locally, filtering CPU/FileIO by server PIDs.

No symbol download, no extrapolation from sampled CPU to individual functions.
FileIoRead Size is requested bytes, NOT physical disk bytes or wire bytes.
"""
import collections, csv, hashlib, json, pathlib, re

ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'artifacts/performance-v4';FOLDER=BASE/'etw'
PID=re.compile(r'\(\s*(\d+)\)\s*$')
# WPT on this French Windows installation exports ANSI 1252 (e.g. 0xAE),
# not UTF-8. Keep this explicit so the preserved CSVs also decode elsewhere.
CSV_ENCODING='cp1252'

def pid(value):
    found=PID.search(value)
    return int(found[1]) if found else None

def integer(value):
    value=value.strip()
    return int(value,16) if value.lower().startswith('0x') else int(value)

def rows(file):
    with file.open(encoding=CSV_ENCODING,errors='strict',newline='') as source:
        for row in csv.reader(source,skipinitialspace=True):
            yield [value.strip() for value in row]

def sha(file):
    with file.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def analyse(label):
    data=json.loads((FOLDER/(label+'.json')).read_text())
    assert data['complete'] is True,label
    names=dict(data['processesBeforeTrace']['pids']);pids=set(names)
    expected=json.loads((BASE/('candidate.json' if 'candidate' in label else 'reference-v3/reference.json')).read_text())['binarySha256']
    assert data['binarySha256']==expected,label
    modules=collections.defaultdict(collections.Counter)
    for row in rows(FOLDER/(label+'-profile.csv')):
        if len(row)==4 and pid(row[0]) in pids:
            modules[pid(row[0])][row[3]]+=integer(row[1])
    assert data['nativePid'] in modules,'Missing native CPU samples'
    headers={};inside_header=False;counts=collections.Counter();file_counts=collections.defaultdict(collections.Counter)
    read_bytes=collections.Counter();threads=collections.defaultdict(set);network=collections.Counter();drops=collections.Counter();event_rows=0
    for row in rows(FOLDER/(label+'-dumper.csv')):
        if not row:continue
        event=row[0]
        if event=='BeginHeader':inside_header=True;continue
        if event=='EndHeader':inside_header=False;continue
        if inside_header:headers[event]=row;continue
        event_rows+=1
        header=headers.get(event)
        if not header or 'Process Name ( PID)' not in header:continue
        offset=header.index('Process Name ( PID)')
        if offset>=len(row):continue
        owner=pid(row[offset])
        if owner not in pids:continue
        if event=='SampledProfile':
            threads[owner].add(integer(row[header.index('ThreadID')]))
        elif event.startswith('FileIo'):
            counts[event]+=1
            if 'FileName' in header:
                filename=row[header.index('FileName')]
                file_counts[filename][event]+=1
                if event=='FileIoRead':read_bytes[filename]+=integer(row[header.index('Size')])
        elif event.startswith('Microsoft-Windows-TCPIP/') or event.startswith('Microsoft-Windows-Networking-Correlation/'):
            # Event execution context only; not a packet/byte accounting API.
            network[event]+=1
            if 'TcpipTransportPacketDrops' in event:
                reason=row[header.index('Reason')]
                drops[reason]+=integer(row[header.index('PacketCount')])
    trace=(FOLDER/(label+'-tracestats.csv')).read_text(encoding=CSV_ENCODING)
    losses={kind:int(re.search(r'Total # Lost '+kind+r'\s*:\s*(\d+)',trace)[1]) for kind in ['Buffers','Events']}
    physical=[]
    app_prefixes=[str(ROOT/'artifacts/performance/app').lower(),str(BASE/'static-app').lower()]
    for row in rows(FOLDER/(label+'-diskio.csv')):
        if len(row)==11 and any(row[-1].lower().startswith(prefix) for prefix in app_prefixes):
            physical.append({'file':row[-1],'operations':integer(row[0]),'bytes':integer(row[1]),'readOperations':integer(row[3]),'readBytes':integer(row[4])})
    total=sum(sum(values.values()) for values in modules.values())
    processes=[{'pid':owner,'name':names[owner],'sampleWeight':sum(values.values()),'serverSamplePercent':100*sum(values.values())/total,'sampledExecutingThreadCount':len(threads[owner]),'modules':[{'module':name,'sampleWeight':weight,'processSamplePercent':100*weight/sum(values.values())} for name,weight in values.most_common()]} for owner,values in modules.items()]
    files=[{'file':name,'events':dict(values),'requestedReadBytes':read_bytes[name]} for name,values in sorted(file_counts.items(),key=lambda item:sum(item[1].values()),reverse=True)]
    inputs={name:sha(FOLDER/name) for name in [label+'.json',label+'.etl',label+'-profile.csv',label+'-dumper.csv',label+'-diskio.csv',label+'-tracestats.csv']}
    return {'label':label,'route':data['route'],'nativePid':data['nativePid'],'binarySha256':expected,'serverPids':names,'responses':data['load']['value']['count'],'httpErrors':data['load']['value']['errors'],'traceStats':trace,'lost':losses,'processes':processes,'fileIoEvents':dict(counts),'files':files,'networkEventsInServerContext':dict(network),'networkDroppedPacketsByRawReason':dict(drops),'physicalDiskForApplicationFilesAllProcesses':physical,'parsedEventRows':event_rows,'inputsSha256':inputs}

def main():
    result={'complete':False,'csvEncoding':CSV_ENCODING,'method':'CPU.light + FileIO.light + Network.light; whole diagnostic trace including generator startup/drain; process-context filtering; sample-weight proportions, not source-level attribution','traces':[]}
    for label in ['v3','candidate','ssr-v3','ssr-candidate']:
        value=analyse(label);result['traces'].append(value)
        print(label,'analysed',value['parsedEventRows'],'event rows; lost',value['lost'],flush=True)
    result['complete']=True
    result['lossless']=all(not any(t['lost'].values()) for t in result['traces'])
    (FOLDER/'analysis.json').write_text(json.dumps(result,indent=2),encoding='utf-8')

if __name__=='__main__':main()
