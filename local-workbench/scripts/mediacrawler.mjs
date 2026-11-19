import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { node, root } from './environment.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：mediacrawler.cmd --keywords "推拿" --crawler_max_notes_count 3');
  process.exit(2);
}

const project = join(root, 'MediaCrawler');
const python = join(project, '.venv', 'Scripts', 'python.exe');
const lock = join(root, '.cache', 'xhs-rate.lock');
let locked = false;
function progress(event) {
  if (process.env.XHS_RESEARCH_PROGRESS) appendFileSync(process.env.XHS_RESEARCH_PROGRESS, `${JSON.stringify({ event })}\n`);
}
function acquireLock() {
  try { return openSync(lock, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(lock, 'utf8'));
    // Reclaim only locks from this launcher with a demonstrably dead owner.
    if (previous.backend !== 'mediacrawler' || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
        !Number.isSafeInteger(previous.childPid) || previous.childPid <= 0) throw error;
    try { process.kill(previous.pid, 0); } catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      try { process.kill(previous.childPid, 0); } catch (childProbe) {
        if (childProbe.code !== 'ESRCH') throw childProbe;
        unlinkSync(lock);
        return openSync(lock, 'wx');
      }
      // A dead Node launcher is not proof that its crawler child has stopped.
      throw error;
    }
    throw error;
  }
}
try {
  if (!existsSync(python)) throw new Error('MediaCrawler Python 环境尚未安装，请查看 MediaCrawler/docs/OPENCLI.md。');
  if (args.some(arg => /^--platform(?:=|$)/.test(arg))) throw new Error('本入口固定使用小红书；其他平台请使用 MediaCrawler 原始入口。');
  const fd = acquireLock();
  locked = true;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, backend: 'mediacrawler', startedAt: new Date().toISOString() }));
  } finally { closeSync(fd); }
  const child = spawn(python, [join(project, 'main.py'), '--platform', 'xhs', '--crawler_max_notes_count', '3',
    '--max_comments_count_singlenotes', '5', '--save_data_path', join(root, 'data', 'mediacrawler'), ...args], {
    cwd: project,
    env: { ...process.env, XHS_BROWSER_BACKEND: process.env.XHS_BROWSER_BACKEND || 'opencli', OPENCLI_NODE_BINARY: node,
      XHS_OPENCLI_STATE_PATH: join(root, '.cache', 'xhs-http-state.json'),
      PYTHONIOENCODING: 'utf-8', PYTHONPYCACHEPREFIX: join(root, '.cache', 'python') },
    stdio: [process.env.XHS_BROWSER_BACKEND === 'openbiliclaw' ? 'pipe' : 'inherit', 'inherit', 'inherit'], windowsHide: true,
  });
  if (process.env.XHS_BROWSER_BACKEND === 'openbiliclaw') {
    // Private pipe only: never put account cookies in argv, env or log files.
    child.stdin.on('error', () => {
      console.error('采集进程无法接收登录态。');
      child.kill();
    });
    process.stdin.pipe(child.stdin);
  }
  if (child.pid) writeFileSync(lock, JSON.stringify({pid:process.pid, childPid:child.pid, backend:'mediacrawler', startedAt:new Date().toISOString()}));
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  if (error.code === 'EEXIST') progress('account_busy');
  console.error(error.code === 'EEXIST' ? '已有小红书任务或遗留锁；未并行启动。请先人工检查 .cache/xhs-rate.lock。' : error.message);
  process.exitCode = 1;
} finally {
  if (locked) unlinkSync(lock);
}
