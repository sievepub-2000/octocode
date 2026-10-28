"""Compare only materialization timing; both paths use identical math."""
import json
import time
import mlx.core as mx

mx.random.seed(17)
q = mx.random.normal((1, 4096, 32, 128)).astype(mx.bfloat16)
k = mx.random.normal((1, 8192, 128)).astype(mx.bfloat16)
w = mx.random.normal((1, 4096, 32)).astype(mx.bfloat16)
mx.eval(q, k, w)
results, hashes = [], []
for bounded in (False, True, True, False, False, True):
    mx.clear_cache()
    mx.reset_peak_memory()
    initial = mx.get_active_memory()
    started = time.perf_counter()
    out = []
    for start in range(0, 4096, 512):
        heads = q[:, start:start+512] @ k[:, None].swapaxes(-1, -2)
        scores = mx.sum(w[:, start:start+512, :, None] *
                        mx.maximum(heads, mx.array(0, heads.dtype)), axis=2)
        if bounded:
            mx.eval(scores)
            del heads
        selected = mx.argpartition(-scores, kth=511, axis=-1)[..., :512]
        out.append(selected)
    selected = mx.concatenate(out, axis=1)
    mx.eval(selected)
    results.append(dict(bounded=bounded, elapsed=time.perf_counter()-started,
                        peak=mx.get_peak_memory(), baseline=initial))
    import hashlib
    import numpy as np
    hashes.append(hashlib.sha256(np.asarray(selected).tobytes()).hexdigest())
    del scores, selected, out
    if not bounded:
        del heads
assert len(set(hashes)) == 1, "Materialization changed selected indices"
print(json.dumps(dict(results=results, identical_indices=True)), flush=True)
