"""Atomic frontend-only publication. No process restart, strategy or financial writes."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile,datetime,sys,urllib.request,urllib.error
FILES=['framework.css','base.css','desk.js','settings-preview.js','connections.js','production.css','production.js']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def states(app):return{p.name:digest(p)for p in app.iterdir()if p.is_file()and(p.suffix=='.json'or p.name.startswith('.env'))}
def backend(app):return{str(p.relative_to(app)):digest(p)for p in list(app.glob('*.js'))+list((app/'terminal').rglob('*.js'))+list((app/'strategy').rglob('*.js'))}
def replace(p,data):
 p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_name(p.name+'.ui-new')
 with temp.open('wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
 os.replace(temp,p)
def publish(app,source,backup,sha,fail_at=None,hook=None,health=None):
 app,source,backup=map(pathlib.Path,[app,source,backup]);assert len(sha)==40 and all(c in'0123456789abcdef'for c in sha)
 assert app.resolve()==app and source.resolve()==source and not app.is_symlink()
 profile=source/'public/terminal/classic';assert all((profile/f).is_file()for f in FILES+['index.html','BASE.json'])
 expected=json.loads((profile/'BASE.json').read_text())
 for name,h in expected['files'].items():
  raw=(app/name).read_text(encoding='utf-8-sig').replace('\r\n','\n').encode();assert hashlib.sha256(raw).hexdigest()==h,'Production controller baseline differs: '+name
 data_before,code_before=states(app),backend(app);backup.mkdir(parents=True,exist_ok=False);backup.chmod(0o700)
 old=(app/'public/index.html').read_bytes();(backup/'index-before.html').write_bytes(old)
 old_marker=(app/'WORKBENCH_UI_COMMIT').read_bytes()if(app/'WORKBENCH_UI_COMMIT').exists()else None
 (backup/'state-hashes.json').write_text(json.dumps(data_before));(backup/'backend-hashes.json').write_text(json.dumps(code_before))
 with tarfile.open(backup/'application-before.tgz','w:gz',dereference=True)as archive:
  for p in app.iterdir():
   if p.name not in ['backups','deploy-backups','.git','.audit']:archive.add(p,arcname=p.name,recursive=True)
 with tarfile.open(backup/'application-before.tgz')as archive:
  for name,h in data_before.items():assert hashlib.sha256(archive.extractfile(name).read()).hexdigest()==h,'Backup state mismatch'
 assert states(app)==data_before,'State changed during backup; no publication performed'
 (backup/'backup-sha256').write_text(digest(backup/'application-before.tgz'))
 target=app/'public/just-desk'/sha;assert not target.exists();assert target.resolve().is_relative_to((app/'public/just-desk').resolve())
 try:
  target.mkdir(parents=True)
  for i,name in enumerate(FILES,1):
   replace(target/name,(profile/name).read_bytes())
   if fail_at==i:raise RuntimeError('INJECTED asset publication failure')
  html=(profile/'index.html').read_text().replace('/terminal/classic/','/just-desk/'+sha+'/').encode();replace(app/'public/index.html',html)
  if hook:hook()
  if fail_at=='html':raise RuntimeError('INJECTED post HTML failure')
  replace(app/'WORKBENCH_UI_COMMIT',(sha+'\n').encode())
  assert backend(app)==code_before,'Backend changed';assert states(app)==data_before,'Financial state changed during static publication'
  assert all(digest(target/n)==digest(profile/n)for n in FILES)
  if health:health(target)
  report={'uiCommit':sha,'backup':str(backup),'backupSha256':digest(backup/'application-before.tgz'),'assets':'/just-desk/'+sha+'/','backendUnchanged':True,'configurationAuthHistoryAndLedgersUnchanged':True,'processRestarted':False}
  (backup/'deployment.json').write_text(json.dumps(report,indent=2));return report
 except BaseException:
  replace(app/'public/index.html',old)
  if old_marker is None:(app/'WORKBENCH_UI_COMMIT').unlink(missing_ok=True)
  else:replace(app/'WORKBENCH_UI_COMMIT',old_marker)
  if target.exists():shutil.rmtree(target)
  assert backend(app)==code_before,'Rollback backend mismatch'
  (backup/'ROLLED_BACK').write_text('Frontend only; current financial files were not restored.\n');raise
if __name__=='__main__':
 source=pathlib.Path(sys.argv[1]).resolve();sha=sys.argv[2];assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==sha
 app=pathlib.Path('/root/app/hyper_safe_ui_v4');assert(app/'.classic-only').exists()
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S');backup=pathlib.Path('/root/app/deploy-backups')/('just-desk-'+sha[:7]+'-'+stamp)
 def health(target):
  for route,wanted in [('/api/public/status',200),('/api/v4/desk',401),('/api/v4/connections',401)]:
   try:
    with urllib.request.urlopen('http://127.0.0.1:3000'+route,timeout=10)as r:status=r.status
   except urllib.error.HTTPError as e:status=e.code
   assert status==wanted,'Health check '+route
  for name in ['production.css','production.js']:
   with urllib.request.urlopen('http://127.0.0.1:3000/just-desk/'+sha+'/'+name,timeout=10)as r:assert hashlib.sha256(r.read()).hexdigest()==digest(target/name),'Published asset differs'
 print(json.dumps(publish(app,source,backup,sha,health=health),indent=2))
