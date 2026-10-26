#!/usr/bin/env python3
"""Verify code against Git blobs; rollback code only, never mutable production state."""
import hashlib, io, json, os, shutil, subprocess, sys, tarfile, tempfile
from pathlib import Path, PurePosixPath
BASELINE='39555bc8fae8d3eedf63af984366d2a48438cb76'
ROOT_FILES={'package.json','package-lock.json','.gitignore','.gitattributes','config.example.json','config.compound.example.json'}
CODE_DIRS={'public','strategy','terminal','scripts','tests','docs'}
SUFFIXES={'.js','.css','.html','.svg','.png','.jpg','.webp','.ico','.md','.sh','.py'}
def allowed(name):
    p=PurePosixPath(name)
    if str(p)!=name or p.is_absolute() or '..' in p.parts or '\\' in name: return False
    if any(x.startswith('.env') or x in {'node_modules','.git','.audit','backups','deploy-backups','__pycache__'} for x in p.parts): return False
    if name in ROOT_FILES or name=='docs/compound_4h_research_20261026.json': return True
    if p.suffix not in SUFFIXES or any(x in p.name.lower() for x in ['private','secret','credential','id_ed25519','id_rsa']): return False
    return len(p.parts)==1 or p.parts[0] in CODE_DIRS
def git(repo,*args): return subprocess.check_output(['git','-C',str(repo),*args])
def tree(repo,sha):
    if len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha): raise ValueError('Invalid SHA')
    if git(repo,'rev-parse',sha+'^{commit}').decode().strip()!=sha: raise ValueError('Commit mismatch')
    subprocess.run(['git','-C',str(repo),'merge-base','--is-ancestor',BASELINE,sha],check=True)
    result={}
    for row in git(repo,'ls-tree','-rz','--full-tree',sha).split(b'\0'):
        if not row: continue
        header,raw=row.split(b'\t',1); mode,kind,oid=header.decode().split(); name=raw.decode()
        if allowed(name):
            if mode not in {'100644','100755'} or kind!='blob': raise ValueError('Release links forbidden: '+name)
            result[name]=(oid,mode)
    if not {'server.js','package.json','package-lock.json'}.issubset(result): raise ValueError('Incomplete source')
    return result
def pack(repo,sha,archive):
    with tarfile.open(archive,'w:gz') as tar:
        for name,(oid,mode) in sorted(tree(repo,sha).items()):
            data=git(repo,'cat-file','blob',oid); info=tarfile.TarInfo(name)
            info.size,info.mode,info.mtime=len(data),0o755 if mode=='100755' else 0o644,0
            tar.addfile(info,io.BytesIO(data))
def verify(repo,sha,archive,stage):
    expected=tree(repo,sha); stage=Path(stage)
    if stage.exists() and any(stage.iterdir()): raise ValueError('Stage must be empty')
    stage.mkdir(parents=True,exist_ok=True); seen=set()
    with tarfile.open(archive,'r:gz') as tar:
        # Validate entire archive before extracting. No links, duplicates or special files.
        for item in tar.getmembers():
            if not item.isfile() or item.name in seen or item.name not in expected or not allowed(item.name): raise ValueError('Unsafe release member: '+item.name)
            data=tar.extractfile(item).read(); oid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
            if oid!=expected[item.name][0]: raise ValueError('Commit content mismatch: '+item.name)
            seen.add(item.name)
        if seen!=set(expected): raise ValueError('Missing release files')
        for item in tar.getmembers():
            target=stage/item.name; target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(tar.extractfile(item).read()); target.chmod(0o755 if expected[item.name][1]=='100755' else 0o644)
    (stage/'DEPLOY_COMMIT').write_text(sha+'\n')
    return len(seen)
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def code_files(root):
    root=Path(root); names=[]
    for base,dirs,files in os.walk(root,followlinks=False):
        rel=Path(base).relative_to(root)
        dirs[:]=[d for d in dirs if not (Path(base)/d).is_symlink() and (str(rel)!='.' or d in CODE_DIRS)]
        for f in files:
            p=Path(base)/f; name=p.relative_to(root).as_posix()
            if allowed(name) or name=='DEPLOY_COMMIT':
                if p.is_symlink(): raise ValueError('Code symlink forbidden: '+name)
                names.append(name)
    return sorted(names)
def states(root):
    # Include future runtime JSON names, not merely a hardcoded list of today's ledgers.
    return {p.name:digest(p) for p in Path(root).iterdir() if p.is_file() and ((p.suffix=='.json' and p.name not in ROOT_FILES and not p.name.endswith('.example.json')) or p.name.startswith('.env'))}
def verify_states(app,dest):
    if states(app)!=json.loads((Path(dest)/'state-before.json').read_text()): raise ValueError('Protected state changed before restart')
    for name in states(app):
        if name.endswith('.json'): json.loads((Path(app)/name).read_text())
def backup(app,dest):
    app,dest=Path(app),Path(dest); dest.mkdir(parents=True,exist_ok=False); dest.chmod(0o700)
    source=dest/'code-before'; source.mkdir(); manifest={}
    for name in code_files(app):
        target=source/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(app/name,target); manifest[name]=digest(target)
    (dest/'code-before.json').write_text(json.dumps(manifest)); (dest/'state-before.json').write_text(json.dumps(states(app)))
    # Includes credentials, hidden state, every runtime and dependencies. Never included in release.
    with tarfile.open(dest/'app-full.tgz','w:gz') as tar:
        for p in app.iterdir():
            if p.name not in {'backups','deploy-backups','.git','.audit'}: tar.add(p,arcname=p.name,recursive=True)
    with tarfile.open(dest/'app-full.tgz') as tar:
        members={x.name:x for x in tar.getmembers() if x.isfile()}
        for name,sha in states(app).items():
            if name not in members or hashlib.sha256(tar.extractfile(members[name]).read()).hexdigest()!=sha: raise ValueError('Backup verification failed: '+name)
    (dest/'backup-sha256').write_text(digest(dest/'app-full.tgz')+'\n'); verify_states(app,dest)
def atomic_copy(source,target):
    target=Path(target); target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_symlink() or any(p.is_symlink() for p in target.parents): raise ValueError('Symlink target forbidden')
    fd,temp=tempfile.mkstemp(prefix='.release-',dir=target.parent)
    try:
        with os.fdopen(fd,'wb') as out: out.write(Path(source).read_bytes()); out.flush(); os.fsync(out.fileno())
        shutil.copymode(source,temp); os.replace(temp,target)
    finally:
        if os.path.exists(temp): os.unlink(temp)
def verify_code(app,stage):
    if code_files(app)!=code_files(stage): raise ValueError('Mixed code tree')
    for name in code_files(stage):
        if digest(Path(app)/name)!=digest(Path(stage)/name): raise ValueError('Code mismatch: '+name)
def install(app,stage,fail_after=0):
    app,stage=Path(app),Path(stage); before=states(app); names=code_files(stage)
    for n,name in enumerate(names,1):
        atomic_copy(stage/name,app/name)
        if fail_after and n==fail_after: raise RuntimeError('INJECTED partial file copy failure')
    for name in set(code_files(app))-set(names): (app/name).unlink()
    verify_code(app,stage)
    if states(app)!=before: raise ValueError('Installation changed mutable state')
def rollback(app,dest):
    app,dest=Path(app),Path(dest); before=states(app); manifest=json.loads((dest/'code-before.json').read_text())
    for name,sha in manifest.items():
        if not (allowed(name) or name=='DEPLOY_COMMIT') or digest(dest/'code-before'/name)!=sha: raise ValueError('Invalid code backup')
    for name in set(code_files(app))-set(manifest): (app/name).unlink()
    for name in manifest: atomic_copy(dest/'code-before'/name,app/name)
    if set(code_files(app))!=set(manifest) or any(digest(app/n)!=h for n,h in manifest.items()): raise ValueError('Incomplete rollback')
    # NEW history/orders written after restart must never be replaced by predeploy copies.
    if states(app)!=before: raise ValueError('Rollback modified state')
if __name__=='__main__':
    mode,*args=sys.argv[1:]
    value={'pack':pack,'verify':verify,'backup':backup,'install':install,'rollback':rollback,'verify-code':verify_code,'verify-states':verify_states}[mode](*args)
    print(mode+': OK'+((' '+str(value)) if value is not None else ''))
