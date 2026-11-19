import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const isWindows = process.platform === 'win32';

// scripts/ -> local-workbench/ -> 仓库根（工作台把代码仓当成工作区根）
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// venv 解释器：Windows 在 Scripts/python.exe，Linux/macOS 在 bin/python。
export const venvPython = dir => join(dir, '.venv', ...(isWindows ? ['Scripts', 'python.exe'] : ['bin', 'python']));

// 工作区专用 Chrome for Testing（来源见 DEPLOYMENT.json）；其他平台暂不提供。
export function chromeExecutable() {
  const layouts = {
    win32: ['chrome-win64', 'chrome.exe'],
    linux: ['chrome-linux64', 'chrome'],
  };
  const layout = layouts[process.platform];
  if (!layout) throw new Error(`暂不支持在 ${process.platform} 上启动工作区专用 Chrome。`);
  return join(root, 'browser', ...layout);
}

// 进程归属校验：Windows 走 CIM，Linux 读 /proc；返回 { commandLine, executablePath, parentPid }。
export function processInfo(pid) {
  if (isWindows) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ExecutablePath,CommandLine,ParentProcessId | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`无法确认进程归属：${result.stderr}`);
    if (!result.stdout.trim()) return null;
    const info = JSON.parse(result.stdout.trim());
    return { commandLine: info.CommandLine || '', executablePath: info.ExecutablePath || '', parentPid: info.ParentProcessId };
  }
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 可能含空格/括号，ppid 在最后一个 ')' 之后的第二个字段。
    const parentPid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return { commandLine, executablePath: '', parentPid };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法确认进程归属：${error.message}`);
  }
}

// 用系统默认程序打开 URL。
export async function openUrl(url) {
  const [command, args] = isWindows ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  // 无桌面环境时 xdg-open 不存在：只提示，不当作失败。
  await new Promise(resolvePromise => {
    child.once('spawn', resolvePromise);
    child.once('error', () => { console.log(`请手动打开：${url}`); resolvePromise(); });
  });
  child.unref();
}
// 优先用仓库自带的 Node；新机器没附带时退回当前 Node（要求 >= 22）。
const bundledNode = join(root, 'runtime', 'node-v22.19.0-win-x64', 'node.exe');
export const node = existsSync(bundledNode) ? bundledNode : process.execPath;
export const cli = join(root, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
export const daemon = join(root, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'daemon.js');
const home = join(root, 'home');
const local = join(home, 'AppData', 'Local');
const paths = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: local,
  TEMP: join(root, '.cache', 'temp'),
  TMP: join(root, '.cache', 'temp'),
  TMPDIR: join(root, '.cache', 'temp'),
  XDG_CACHE_HOME: join(root, '.cache'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  npm_config_cache: join(root, '.cache', 'npm'),
  npm_config_prefix: join(root, 'runtime', 'npm-global'),
  OPENCLI_CONFIG_DIR: join(home, '.opencli'),
  OPENCLI_CACHE_DIR: join(root, '.cache', 'opencli'),
  PUPPETEER_CACHE_DIR: join(root, '.cache', 'puppeteer'),
  PLAYWRIGHT_BROWSERS_PATH: join(root, '.cache', 'playwright'),
};
for (const [key, value] of Object.entries(paths)) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
for (const name of ['data', 'logs', 'data/media', 'data/xiaohongshu']) {
  mkdirSync(join(root, name), { recursive: true });
}
if (isWindows) {
  process.env.HOMEDRIVE = root.slice(0, 2);
  process.env.HOMEPATH = home.slice(2);
}
process.env.PATH = [dirname(node), join(root, 'node_modules', '.bin'), process.env.PATH || ''].join(delimiter);
process.env.CHROME_LOG_FILE = join(root, 'logs', 'chrome.log');
process.env.OPENCLI_SITE_SLOTS = 'xiaohongshu:1:60000-90000';
process.env.OPENCLI_WINDOW = 'foreground';
delete process.env.OPENCLI_CDP_ENDPOINT;
delete process.env.OPENCLI_CDP_TARGET;
delete process.env.OPENCLI_PROFILE;
delete process.env.OPENCLI_DAEMON_PORT;
process.chdir(root);
