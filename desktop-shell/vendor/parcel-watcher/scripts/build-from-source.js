#!/usr/bin/env node

const {spawn} = require('child_process');
const path = require('path');

if ((process.env.npm_package_config_node_gyp_build_from_source ?? process.env.npm_config_build_from_source) === 'true') {
  build();
}

function build() {
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js', {
    paths: [process.env.npm_execpath ? path.dirname(process.env.npm_execpath) : process.cwd()],
  });
  spawn(process.execPath, [nodeGyp, 'rebuild'], {stdio: 'inherit', shell: false}).on('error', error => {
    console.error(error);
    process.exit(1);
  }).on(
    'exit',
    function (code) {
      process.exit(code ?? 1);
    },
  );
}
