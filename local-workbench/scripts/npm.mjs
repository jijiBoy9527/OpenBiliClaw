import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { node, root } from './environment.mjs';

// Windows 的 npm 在 node.exe 同目录；Linux/macOS 在 ../lib/node_modules。
const npmCli = [
  join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(existsSync);
if (!npmCli) { console.error('找不到 npm-cli.js，请确认 Node 自带 npm。'); process.exit(1); }

const child = spawn(node, [npmCli, ...process.argv.slice(2)], {
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
