// Use node-gyp's standard hook so the public test addon resolves Node APIs from Electron.
#define HOST_BINARY "node.exe"
#include "../../../.build/environments/node/node_modules/npm/node_modules/node-gyp/src/win_delay_load_hook.cc"
