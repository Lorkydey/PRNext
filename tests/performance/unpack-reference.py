"""Hash-check a supplied local baseline archive and extract only regular files."""
import hashlib, pathlib, sys, tarfile
source,expected,destination=sys.argv[1:]
source=pathlib.Path(source);destination=pathlib.Path(destination).resolve()
if hashlib.sha256(source.read_bytes()).hexdigest()!=expected.lower():raise SystemExit('v3 archive hash mismatch')
if destination.exists():raise SystemExit('Refusing to overwrite a prior reference directory')
with tarfile.open(source,'r:gz') as archive:
    members=archive.getmembers()
    for entry in members:
        name=pathlib.PurePosixPath(entry.name)
        if name.is_absolute() or '..' in name.parts or not (entry.isfile() or entry.isdir()):raise SystemExit('Unsafe archive entry: '+entry.name)
        if name.parts[0] not in ['reference.json','source']:raise SystemExit('Unexpected archive root: '+entry.name)
    destination.mkdir(parents=True)
    archive.extractall(destination,filter='data')
print(destination)
