#!/usr/bin/env python3
"""App-managed, version-checked overrides; the vendor-signed bundle stays intact."""
import hashlib,importlib.util,json,pathlib,runpy,sys
root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'manifest.json').read_text())
vendor=pathlib.Path('/Applications/oMLX.app/Contents/Resources/omlx')
for name,hashes in manifest.items():
    for path,expected in [(vendor/name,hashes['vendor']),(root/name,hashes['patched'])]:
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise RuntimeError(f'oMLX override version mismatch: {path}. Revalidate the patch before starting.')
import omlx
omlx.__path__.insert(0,str(root))
# cache/__init__.py eagerly imports the SSD manager. Set its package search
# paths before executing it, otherwise its classes stay bound to vendor code.
spec=importlib.util.spec_from_file_location('omlx.cache',vendor/'cache/__init__.py',submodule_search_locations=[str(root/'cache'),str(vendor/'cache')])
cache=importlib.util.module_from_spec(spec)
sys.modules['omlx.cache']=cache
omlx.cache=cache
spec.loader.exec_module(cache)
assert pathlib.Path(sys.modules['omlx.cache.paged_ssd_cache'].__file__).resolve()==root/'cache/paged_ssd_cache.py'
base=(pathlib.Path.home()/'Library/Application Support/oMLX/base-path').read_text().strip()
assert pathlib.Path(base).is_dir(),base
print('OMLX_WARNING_FIX_ACTIVE '+str(root),flush=True)
sys.argv=[sys.argv[0],'serve','--base-path',base,*sys.argv[1:]]
runpy.run_module('omlx.cli',run_name='__main__')
