import ast, contextlib, pathlib, sys, types

tree=ast.parse(pathlib.Path(sys.argv[1]).read_text())
close=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='close' and 'hot cache' in (ast.get_docstring(n) or ''))
flush=next(n for n in close.body if isinstance(n,ast.If))
code=compile(ast.fix_missing_locations(ast.Module(body=[flush],type_ignores=[])),str(sys.argv[1]),'exec')
for memory_only,write_ok in [(True,False),(False,True),(False,False)]:
    writes=[];warnings=[]
    entry={'dirty':True,'block_metadata':None}
    obj=types.SimpleNamespace(_hot_cache_enabled=True,_hot_cache_only=memory_only,_hot_cache_lock=contextlib.nullcontext(),_hot_cache={b'block':entry},_writer_thread=None)
    def enqueue(*args,**kwargs):writes.append(args);return write_ok
    obj._enqueue_ssd_write=enqueue
    logger=types.SimpleNamespace(info=lambda *args:None,warning=warnings.append)
    exec(code,{'self':obj,'logger':logger})
    assert len(writes)==int(not memory_only),(memory_only,writes)
    assert bool(warnings)==(not memory_only and not write_ok),(memory_only,warnings)
print('CACHE_CLOSE_MEMORY_SSD_FAILURE_CHECKS_OK')
