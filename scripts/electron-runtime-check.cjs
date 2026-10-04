'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const executable = require('electron');
const child = spawn(executable, [path.join(__dirname, 'electron-runtime-check.mjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
child.once('error', () => { process.stderr.write('Electron runtime check could not start.\n'); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
