# deepmerge security copy

Upstream: https://github.com/TehShrike/deepmerge, npm `deepmerge@4.3.1`.
Original archive SHA-512 (base64):
`3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==`.

The six upstream source, distribution, type, license and readme files were imported
from the integrity-verified npm archive. `license.txt` remains unchanged.

Local patch for [CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4):
all three writes to the destination object in `mergeObject` use
`Object.defineProperty` to create ordinary writable, configurable, enumerable data
properties. This prevents an inherited `__proto__` setter from changing the
result's prototype, including when the target already has an own `__proto__` key
or has a null prototype. The source and both distributed entrypoints carry the
same change; key selection, recursion, array handling and custom options remain.

The namespaced local package avoids claiming to be an upstream patched release.
Upstream has no patched release at verification time (2026-10-28). Run
`node --test security.test.cjs`; reconsider this copy when upstream publishes a fix.
