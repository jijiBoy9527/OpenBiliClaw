import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, node, root } from './environment.mjs';

export const policy = Object.freeze({ minGapSeconds: 60, maxGapSeconds: 90, maxPerHour: 12, maxPer24Hours: 40 });
const stateFile = join(root, '.cache', 'xhs-rate.json');
const lockFile = join(root, '.cache', 'xhs-rate.lock');
const logFile = join(root, 'logs', 'xhs-rate.jsonl');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function loadState() {
  if (!existsSync(stateFile)) return { version: 1, history: [], nextAt: Date.now() + 60_000, blocked: null };
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (state.version !== 1 || !Array.isArray(state.history) || !state.history.every(Number.isFinite) || !Number.isFinite(state.nextAt)) {
    throw new Error('限速状态文件异常，拒绝访问小红书。请检查 .cache/xhs-rate.json。');
  }
  return state;
}
function saveState(state) {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}
function event(data) { appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n'); }
function assertOpen(state) {
  if (state.blocked || state.pending) throw new Error(`小红书采集已暂停：${state.blocked?.message || '上次操作中断、结果未确认'}。请先人工检查浏览器，不能直接重跑。见 README 的解除暂停说明。`);
}

function invoke(args, inherit) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], { cwd: root, env: process.env, windowsHide: true,
      stdio: ['inherit', inherit ? 'inherit' : 'pipe', 'inherit'] });
    let stdout = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
    }
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout }));
  });
}

// Hold the same lock throughout a complete workflow, including its waiting time.
// A second process fails instead of creating another account activity stream.
export async function withXhsClient(action) {
  let fd;
  try { fd = openSync(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有小红书任务持有全局锁，或上次任务异常退出。不会并行启动；请检查 .cache/xhs-rate.lock。');
    throw error;
  }
  try {
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    finally { closeSync(fd); }
    const state = loadState();
    assertOpen(state);
    saveState(state);
    let busy = false;
    const run = async (args, { inherit = false } = {}) => {
      if (busy) throw new Error('禁止在同一个小红书任务内并发执行命令。');
      busy = true;
      try {
        assertOpen(state);
        const now = Date.now();
        state.history = state.history.filter(at => now - at < 86_400_000);
        if (state.history.length >= policy.maxPer24Hours || state.history.filter(at => now - at < 3_600_000).length >= policy.maxPerHour) {
          throw new Error('已达到小红书操作额度（每小时 12 次 / 滚动24小时 40 次），停止本批任务，不自动等待后继续。');
        }
        const wait = Math.max(0, state.nextAt - now);
        if (wait) { console.error(`限速等待 ${Math.ceil(wait / 1000)} 秒；单任务串行。`); await sleep(wait); }
        const started = Date.now();
        const command = args.slice(0, 2).join('/');
        state.pending = { startedAt: started, command };
        state.history.push(started);
        saveState(state);
        event({ event: 'started', command });
        let outcome;
        try {
          const raw = await invoke(args, inherit);
          if (inherit) {
            if (raw.code !== 0) throw new Error(`OpenCLI 退出码 ${raw.code}；暂停采集，等待人工检查。`);
            outcome = null;
          } else {
            try { outcome = JSON.parse(raw.stdout); }
            catch { throw new Error(`OpenCLI 返回非 JSON（退出码 ${raw.code}），暂停采集。`); }
            if (raw.code !== 0 || outcome.ok !== true) {
              const error = new Error(outcome.error?.message || `OpenCLI 退出码 ${raw.code}`);
              error.detail = outcome.error;
              throw error;
            }
          }
          delete state.pending;
          state.nextAt = Date.now() + (60 + Math.floor(Math.random() * 31)) * 1000;
          saveState(state);
          event({ event: 'completed', command, nextAt: new Date(state.nextAt).toISOString() });
          return outcome;
        } catch (error) {
          state.blocked = { at: new Date().toISOString(), code: error.detail?.code || 'OPERATION_FAILED', message: error.message };
          state.nextAt = Date.now() + 30 * 60_000;
          delete state.pending;
          saveState(state);
          event({ event: 'paused', command, code: state.blocked.code });
          throw error;
        }
      } finally { busy = false; }
    };
    return await action(run);
  } finally { unlinkSync(lockFile); }
}

export function rateStatus() { return { policy, state: loadState(), lock: existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null }; }

export function resumeAfterManualCheck() {
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    try { process.kill(lock.pid, 0); throw new Error('原任务仍在运行，不能解除锁。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockFile);
  }
  // No asynchronous work occurs between exclusive lock acquisition and release.
  const fd = openSync(lockFile, 'wx');
  try {
    const state = loadState();
    delete state.pending;
    state.blocked = null;
    state.nextAt = Math.max(state.nextAt, Date.now() + 30 * 60_000);
    saveState(state);
    event({ event: 'manually-resumed', nextAt: new Date(state.nextAt).toISOString() });
    return state;
  } finally { closeSync(fd); unlinkSync(lockFile); }
}
