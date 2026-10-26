#!/usr/bin/env python3
"""Isolated deployment fault injection; no production configuration, SDK or PM2."""
import hashlib, importlib.util, io, tarfile, tempfile, unittest
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard',Path(__file__).resolve().parents[1]/'scripts/release_guard.py')
guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
class DeploymentTests(unittest.TestCase):
    def fixture(self,root):
        app,stage,backup=root/'app',root/'stage',root/'backup'; app.mkdir(); stage.mkdir()
        for name,text in {'server.js':'old','old.js':'retired','DEPLOY_COMMIT':'old SHA','config.json':'{"accounts":[1]}','auth.json':'{"hash":"retain"}','profit_history.json':'{"history":[1]}','future_runtime.json':'{"orders":[1]}','.env':'never publish'}.items(): (app/name).write_text(text)
        for name,text in {'server.js':'new','added.js':'new file','DEPLOY_COMMIT':'new SHA'}.items(): (stage/name).write_text(text)
        guard.backup(app,backup); return app,stage,backup
    def test_partial_copy_fault_removes_added_files_restores_complete_code(self):
        with tempfile.TemporaryDirectory() as d:
            app,stage,backup=self.fixture(Path(d)); before={n:guard.digest(app/n) for n in guard.code_files(app)}
            with self.assertRaisesRegex(RuntimeError,'INJECTED'): guard.install(app,stage,fail_after=2)
            guard.rollback(app,backup)
            self.assertEqual(before,{n:guard.digest(app/n) for n in guard.code_files(app)}); self.assertFalse((app/'added.js').exists()); guard.verify_states(app,backup)
    def test_restart_failure_rollback_preserves_NEW_orders_and_history(self):
        with tempfile.TemporaryDirectory() as d:
            app,stage,backup=self.fixture(Path(d)); guard.install(app,stage)
            self.assertFalse((app/'old.js').exists())
            (app/'future_runtime.json').write_text('{"orders":[1,2]}'); (app/'profit_history.json').write_text('{"history":[1,2]}')
            state=guard.states(app); guard.rollback(app,backup)
            self.assertEqual(state,guard.states(app)); self.assertEqual((app/'server.js').read_text(),'old'); self.assertTrue((app/'old.js').exists()); self.assertFalse((app/'added.js').exists())
    def test_sensitive_paths_and_traversal_rejected(self):
        for name in ['config.json','auth.json','key.pem','.env','../server.js','public/../../auth.json','node_modules/a.js','trend_only_runtime.json','docs/private-secret.js','auth.example.json']: self.assertFalse(guard.allowed(name),name)
        self.assertTrue(guard.allowed('server.js'))
    def test_tampered_backup_rejected_before_restore(self):
        with tempfile.TemporaryDirectory() as d:
            app,stage,backup=self.fixture(Path(d)); guard.install(app,stage); (backup/'code-before/server.js').write_text('tampered')
            with self.assertRaises(ValueError): guard.rollback(app,backup)
            self.assertEqual((app/'server.js').read_text(),'new')
    def test_archive_content_path_duplicate_and_symlink_tampering_rejected(self):
        data=b'verified server'; oid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        with tempfile.TemporaryDirectory() as d, patch.object(guard,'tree',return_value={'server.js':(oid,'100644')}):
            root=Path(d)
            for mode in ['changed','private','duplicate','symlink','traversal','missing']:
                archive=root/(mode+'.tgz')
                with tarfile.open(archive,'w:gz') as tar:
                    entries=[] if mode=='missing' else [('server.js',b'forged' if mode=='changed' else data)]
                    if mode=='private': entries.append(('auth.json',b'{}'))
                    if mode=='duplicate': entries.append(('server.js',data))
                    if mode=='traversal': entries.append(('../server.js',data))
                    for name,value in entries:
                        item=tarfile.TarInfo(name); item.size=len(value)
                        if mode=='symlink': item.type=tarfile.SYMTYPE; item.linkname='/etc/passwd'
                        tar.addfile(item,io.BytesIO(value) if item.isfile() else None)
                with self.assertRaises(ValueError,msg=mode): guard.verify(root,'a'*40,archive,root/mode)
                self.assertFalse((root/mode/'server.js').exists())
    def test_validated_archive_is_the_only_extracted_code(self):
        data=b'verified server'; oid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        with tempfile.TemporaryDirectory() as d, patch.object(guard,'tree',return_value={'server.js':(oid,'100644')}):
            root=Path(d); archive=root/'release.tgz'
            with tarfile.open(archive,'w:gz') as tar:
                item=tarfile.TarInfo('server.js'); item.size=len(data); tar.addfile(item,io.BytesIO(data))
            self.assertEqual(guard.verify(root,'a'*40,archive,root/'stage'),1)
            self.assertEqual((root/'stage/server.js').read_bytes(),data)
            self.assertEqual((root/'stage/DEPLOY_COMMIT').read_text().strip(),'a'*40)
if __name__=='__main__': unittest.main(verbosity=2)
