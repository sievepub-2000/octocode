"""Use the App Python/dependencies; execute the loader without starting a server."""
if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import pathlib, runpy, sys
from unittest.mock import patch
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime/hotfixes/dev4-warnings'
with patch.object(runpy, 'run_module') as server:
    runpy.run_path(str(root / 'serve.py'), run_name='__main__')
    server.assert_called_once_with('omlx.cli', run_name='__main__')
module = sys.modules['omlx.cache.paged_ssd_cache']
expected = root / 'cache/paged_ssd_cache.py'
assert pathlib.Path(module.__file__).resolve() == expected
assert pathlib.Path(module.PagedSSDCacheManager.close.__code__.co_filename).resolve() == expected
assert sys.modules['omlx.cache'].PagedSSDCacheManager is module.PagedSSDCacheManager
print('Package eager import and exported cache class both use the validated override')
