import { spawn } from 'node:child_process';
import { cli, node, root } from './environment.mjs';
import { withXhsClient } from './xhs-client.mjs';

const args = process.argv.slice(2);
const guarded = !args.some(arg => ['--help', '-h', '--version', '-V'].includes(arg))
  && (args.includes('xiaohongshu') || args.includes('browser'));
if (guarded) {
  const formatIndex = args.findIndex(arg => arg === '-f' || arg === '--format');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : args.find(arg => arg.startsWith('--format='))?.slice(9);
  try {
    const result = await withXhsClient(run => run(args, { inherit: Boolean(format && format !== 'json') }));
    if (result) console.log(JSON.stringify(result));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const child = spawn(node, [cli, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
