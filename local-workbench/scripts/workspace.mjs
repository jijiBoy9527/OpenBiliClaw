import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemon, node, root } from './environment.mjs';

const bridgeUrl = 'http://127.0.0.1:19825';
const hotUrl = 'http://127.0.0.1:6688';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(url) {
  try {
    const response = await fetch(url, { headers: { 'X-OpenCLI': '1' }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  }
}

function ownsProcess(pid, script) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`],
  { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`无法确认进程归属：${result.stderr}`);
  return result.stdout.toLowerCase().includes(script.toLowerCase());
}

async function launchService(script, logName, ready) {
  const out = openSync(join(root, 'logs', `${logName}.stdout.log`), 'a');
  const err = openSync(join(root, 'logs', `${logName}.stderr.log`), 'a');
  let child;
  try {
    child = spawn(node, [script], {
      cwd: root, env: { ...process.env, NODE_ENV: 'production' },
      detached: true, stdio: ['ignore', out, err], windowsHide: true,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  for (let i = 0; i < 30; i++) {
    if (await ready()) return;
    if (child.exitCode !== null) throw new Error(`${logName} 启动失败，请查看 logs 目录。`);
    await sleep(500);
  }
  throw new Error(`${logName} 尚未报告就绪，请查看 logs 目录；不要重复启动。`);
}

async function ensureDaemon() {
  const state = await readJson(`${bridgeUrl}/status`);
  if (state) {
    if (!ownsProcess(state.pid, daemon)) throw new Error('19825 由另一个 OpenCLI 安装占用。请先从原安装停止空闲守护进程；不会自动终止其他环境。');
    return;
  }
  await launchService(daemon, 'opencli-daemon', async () => {
    const state = await readJson(`${bridgeUrl}/status`);
    return state && ownsProcess(state.pid, daemon);
  });
}

async function ensureHotApi() {
  const state = await readJson(`${hotUrl}/__workspace`);
  if (state) {
    if (state.root !== root) throw new Error('6688 已由其他服务占用。');
    return;
  }
  await launchService(join(root, 'scripts', 'dailyhot.mjs'), 'dailyhot', async () => {
    const state = await readJson(`${hotUrl}/__workspace`);
    return state?.root === root;
  });
}

async function openBrowser() {
  await ensureDaemon();
  const profile = join(root, 'browser', 'profile');
  const preferences = join(profile, 'Default', 'Preferences');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  if (!existsSync(preferences)) {
    writeFileSync(preferences, JSON.stringify({
      download: { default_directory: join(root, 'data', 'media'), prompt_for_download: false },
      extensions: { ui: { developer_mode: true } },
      browser: { check_default_browser: false },
    }));
  }
  const extension = join(root, 'browser', 'opencli-extension');
  const browser = spawn(join(root, 'browser', 'chrome-win64', 'chrome.exe'), [
    `--user-data-dir=${profile}`, `--disk-cache-dir=${join(root, '.cache', 'chrome')}`,
    '--disk-cache-size=268435456', '--media-cache-size=134217728',
    `--crash-dumps-dir=${join(root, '.cache', 'chrome-crashes')}`,
    `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--disable-component-update', '--disable-breakpad', 'https://www.xiaohongshu.com/explore',
  ], { cwd: root, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
  browser.unref();
  console.log('已打开工作区专用 Chrome。请在其中自行登录小红书；不要关闭浏览器后再采集。');
}

async function stopServices() {
  const hot = await readJson(`${hotUrl}/__workspace`);
  if (hot) {
    if (hot.root !== root || !ownsProcess(hot.pid, join(root, 'scripts', 'dailyhot.mjs'))) {
      throw new Error('6688 不属于本工作区，未停止。');
    }
    process.kill(hot.pid);
    console.log('DailyHotApi 已停止。');
  }
  const bridge = await readJson(`${bridgeUrl}/status`);
  if (bridge) {
    if (!ownsProcess(bridge.pid, daemon)) throw new Error('OpenCLI 守护进程不属于本工作区，未停止。');
    if (bridge.pending > 0 || bridge.sessionLeases?.length) throw new Error('OpenCLI 正在执行任务，请结束任务后再停止。');
    const response = await fetch(`${bridgeUrl}/shutdown`, { method: 'POST', headers: { 'X-OpenCLI': '1' } });
    if (!response.ok) throw new Error(`停止 OpenCLI 失败：HTTP ${response.status}`);
    console.log('OpenCLI 已停止。');
  }
  console.log('浏览器未强制关闭；请自行关闭专用 Chrome，以正常保存登录数据。');
}

try {
  const action = process.argv[2];
  if (action === 'start') {
    await ensureDaemon();
    await ensureHotApi();
    await openBrowser();
    console.log(`DailyHotApi: ${hotUrl}`);
  } else if (action === 'api') await ensureHotApi();
  else if (action === 'browser') await openBrowser();
  else if (action === 'stop') await stopServices();
  else if (action === 'status') {
    const bridge = await readJson(`${bridgeUrl}/status`);
    const hot = await readJson(`${hotUrl}/__workspace`);
    console.log(JSON.stringify({ root, opencli: bridge, dailyhot: hot,
      note: 'extensionConnected 仅表示浏览器桥接已连接，不代表小红书已登录。' }, null, 2));
  } else throw new Error('用法：workspace.mjs start|api|browser|stop|status');
} catch (error) { console.error(error.message); process.exitCode = 1; }
