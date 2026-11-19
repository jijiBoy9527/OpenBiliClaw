import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { node, root } from './environment.mjs';

const child = spawn(node, [join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...process.argv.slice(2)], {
  cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  if (code === 0 && ['install', 'i', 'ci'].includes(process.argv[2])) {
    const patch = spawn(node, [join(root, 'scripts', 'apply-patches.mjs')], {
      cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
    });
    patch.on('error', error => { console.error(error.message); process.exitCode = 1; });
    patch.on('exit', result => { process.exitCode = result ?? 1; });
  }
});
