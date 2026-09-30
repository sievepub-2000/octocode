import importlib.util, pathlib, tempfile, hashlib, json, shutil, subprocess
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('updater', pathlib.Path(__file__).with_name('update-dev.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    updater.FIX = root / 'fix'
    updater.FIX.mkdir()
    app = root / 'Candidate.app'
    module = app / 'Contents/Resources/omlx/scheduler.py'
    module.parent.mkdir(parents=True)
    module.write_text('upstream')
    (updater.FIX / 'scheduler.py').write_text('patched')
    (updater.FIX / 'manifest.json').write_text(json.dumps({'scheduler.py': {'vendor': hashlib.sha256(b'upstream').hexdigest(), 'patched': hashlib.sha256(b'patched').hexdigest()}}))
    updater.compatible(app)
    module.write_text('changed upstream')
    try:
        updater.compatible(app)
    except RuntimeError as error:
        assert 'needs review' in str(error)
    else:
        raise AssertionError('Incompatible upstream accepted')
    module.write_text('upstream')
    (updater.FIX / 'scheduler.py').write_text('changed patch')
    try:
        updater.compatible(app)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Changed override accepted')
print('Compatible version accepted; changed upstream and override rejected before shutdown')

# Exercise the real filesystem switch and rollback with platform commands isolated.
for fail in ('', 'model regression', 'stop failed', 'bootout failed', 'cleanup failed'):
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        updater.APP = root / 'oMLX.app'
        updater.APP.mkdir()
        (updater.APP / 'version').write_text('old')
        candidate = root / 'candidate'
        candidate.mkdir()
        (candidate / 'version').write_text('new')
        def command(*args):
            if args[0] == 'ditto':
                shutil.copytree(args[1], args[2])
            if fail == 'stop failed' and args[-1] == 'stop':
                raise RuntimeError(fail)
            if fail == 'bootout failed' and args[:2] == ('launchctl', 'bootout'):
                raise RuntimeError(fail)
            return ''
        def native(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if args[0] == 'lsof' else 0, '', 'TeamIdentifier=PSK5Q5T46L')
        remove_tree = shutil.rmtree
        def cleanup(path, *args, **kwargs):
            if fail == 'cleanup failed' and pathlib.Path(path).name == 'oMLX-update-rollback.app':
                raise RuntimeError(fail)
            return remove_tree(path, *args, **kwargs)
        with patch.object(updater, 'compatible'), patch.object(updater, 'run', command), patch.object(updater.subprocess, 'run', native), patch.object(updater.shutil, 'rmtree', cleanup), patch.object(updater, 'await_model', side_effect=[RuntimeError(fail), None] if fail == 'model regression' else [None]) as readiness:
            if fail:
                try:
                    updater.install(candidate)
                except RuntimeError as error:
                    assert str(error) == fail
                else:
                    raise AssertionError('Failed model was accepted')
            else:
                updater.install(candidate)
            assert readiness.called, 'Service readiness must be checked after recovery'
        assert (updater.APP / 'version').read_text() == ('old' if fail and fail != 'cleanup failed' else 'new')
        assert not (root / 'oMLX-update.app').exists()
        assert (root / 'oMLX-update-rollback.app').exists() == (fail == 'cleanup failed')
print('Successful replacement and failed-readiness rollback passed with isolated native commands')
