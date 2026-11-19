import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const node = join(root, 'runtime', 'node-v22.19.0-win-x64', 'node.exe');
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
process.env.HOMEDRIVE = root.slice(0, 2);
process.env.HOMEPATH = home.slice(2);
process.env.PATH = `${dirname(node)};${join(root, 'node_modules', '.bin')};${process.env.PATH || ''}`;
process.env.CHROME_LOG_FILE = join(root, 'logs', 'chrome.log');
process.env.OPENCLI_SITE_SLOTS = 'xiaohongshu:1:60000-90000';
process.env.OPENCLI_WINDOW = 'foreground';
delete process.env.OPENCLI_CDP_ENDPOINT;
delete process.env.OPENCLI_CDP_TARGET;
delete process.env.OPENCLI_PROFILE;
delete process.env.OPENCLI_DAEMON_PORT;
process.chdir(root);
