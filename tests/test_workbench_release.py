import importlib.util,unittest,tempfile,pathlib,json,hashlib
spec=importlib.util.spec_from_file_location('release',pathlib.Path(__file__).parents[1]/'scripts/deploy_workbench_ui.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ReleaseTest(unittest.TestCase):
 def fixture(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=pathlib.Path(tmp.name).resolve();app=root/'app';source=root/'source';profile=source/'public/terminal/classic';profile.mkdir(parents=True);(app/'public').mkdir(parents=True);(app/'terminal').mkdir();(app/'strategy').mkdir();(app/'public/index.html').write_text('old UI');(app/'server.js').write_text('old engine');(app/'config.json').write_text('{"accounts":[{"id":"retained"}]}');(app/'history.json').write_text('[1]');(app/'auth.json').write_text('{"hash":"retained"}')
  for name in m.FILES:(profile/name).write_text('asset '+name)
  (profile/'index.html').write_text('<link href="/terminal/classic/production.css">new UI');(profile/'BASE.json').write_text(json.dumps({'files':{}}));return app,source,root/'backup'
 def test_success_keeps_all_state_and_engine(self):
  app,src,b=self.fixture();before=m.states(app);r=m.publish(app,src,b,'a'*40);self.assertEqual(m.states(app),before);self.assertEqual((app/'server.js').read_text(),'old engine');self.assertFalse(r['processRestarted']);self.assertIn('/just-desk/'+'a'*40,(app/'public/index.html').read_text())
 def test_partial_assets_failure_rolls_back_new_files(self):
  app,src,b=self.fixture()
  with self.assertRaises(RuntimeError):m.publish(app,src,b,'b'*40,fail_at=3)
  self.assertEqual((app/'public/index.html').read_text(),'old UI');self.assertFalse((app/'public/just-desk'/('b'*40)).exists());self.assertEqual((app/'history.json').read_text(),'[1]')
 def test_post_publish_rollback_keeps_new_financial_history(self):
  app,src,b=self.fixture()
  with self.assertRaises(RuntimeError):m.publish(app,src,b,'c'*40,fail_at='html',hook=lambda:(app/'history.json').write_text('[1,2]'))
  self.assertEqual((app/'public/index.html').read_text(),'old UI');self.assertEqual((app/'history.json').read_text(),'[1,2]');self.assertFalse((app/'WORKBENCH_UI_COMMIT').exists())
 def test_unknown_controller_baseline_stops_before_backup(self):
  app,src,b=self.fixture();(src/'public/terminal/classic/BASE.json').write_text(json.dumps({'files':{'server.js':'wrong'}}))
  with self.assertRaises(AssertionError):m.publish(app,src,b,'d'*40)
  self.assertFalse(b.exists());self.assertEqual((app/'public/index.html').read_text(),'old UI')
 def test_failed_health_check_rolls_back_frontend_only(self):
  app,src,b=self.fixture();before=m.states(app)
  with self.assertRaises(ZeroDivisionError):m.publish(app,src,b,'e'*40,health=lambda target:1/0)
  self.assertEqual((app/'public/index.html').read_text(),'old UI');self.assertEqual(m.states(app),before);self.assertFalse((app/'public/just-desk'/('e'*40)).exists())
if __name__=='__main__':unittest.main()
