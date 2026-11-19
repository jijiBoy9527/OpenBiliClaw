import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment.mjs';

const sourceFile = join(root, 'runtime', 'research-source.txt');
// 合并后仓库自带源码：没有 research-source.txt / apps 副本时，直接把仓库根当源码根。
const hasInlineSource = existsSync(join(root, 'src', 'openbiliclaw', 'research', 'api.py'));
const appRoot = existsSync(sourceFile)
  ? readFileSync(sourceFile, 'utf8').trim()
  : hasInlineSource
    ? root
    : join(root, 'apps', 'OpenBiliClaw-research');
// 本机 worktree 复用 apps 下的 venv；新机器直接用仓库根 .venv。
const python = [
  join(appRoot, '.venv', 'Scripts', 'python.exe'),
  join(root, 'apps', 'OpenBiliClaw-research', '.venv', 'Scripts', 'python.exe'),
  join(root, '.venv', 'Scripts', 'python.exe'),
].find((candidate) => existsSync(candidate)) || '';
const base = 'http://127.0.0.1:8766';
const pageUrl = `${base}/web/${process.argv.includes('--settings') ? '?settings=sources' : '#research'}`;
async function status() {
  try {
    const response = await fetch(`${base}/api/research/status`, { headers:{'X-OBC-Auth':'1'}, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`8766 端口上的服务返回 HTTP ${response.status}，不会重复启动。`);
    const data = await response.json();
    if (data.application !== 'openbiliclaw-research' || data.workspace !== root) throw new Error('8766 已由其他服务或工作区占用。');
    return data;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  }
}

try {
  const existing = await status();
  if (process.argv.includes('--status')) {
    console.log(existing ? `研究工作台已运行：${base}/web/#research` : '研究工作台未运行。');
    process.exit(0);
  }
  if (process.argv.includes('--stop')) {
    if (!existing) { console.log('研究工作台未运行。'); process.exit(0); }
    const response = await fetch(`${base}/api/research/jobs`, {headers:{'X-OBC-Auth':'1'},signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('无法确认任务队列状态，未停止服务。');
    const jobs = await response.json();
    if (jobs.items.some(job => ['queued','running','stopping'].includes(job.state))) throw new Error('请先在 UI 中停止或等待全部任务结束，再关闭服务。');
    if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0) throw new Error('服务 PID 无效，未停止。');
    const check = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter 'ProcessId=${existing.pid}' | Select-Object ExecutablePath,CommandLine,ParentProcessId | ConvertTo-Json -Compress`],
      {encoding:'utf8',windowsHide:true});
    if (check.status !== 0 || !check.stdout.trim()) throw new Error('无法确认服务进程归属，未停止。');
    const info = JSON.parse(check.stdout.trim());
    if (!info.CommandLine?.includes('openbiliclaw.research.api:create_app')) throw new Error('进程不属于本工作台，未停止。');
    if (info.ExecutablePath?.toLowerCase() !== python.toLowerCase()) {
      // Windows venv python.exe is a redirector: Uvicorn may run in its base-python child.
      // Verify the exact venv parent instead of trusting a generic python.exe child.
      if (!Number.isSafeInteger(info.ParentProcessId) || info.ParentProcessId <= 0) throw new Error('无法确认虚拟环境父进程，未停止。');
      const parent = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter 'ProcessId=${info.ParentProcessId}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
        {encoding:'utf8',windowsHide:true});
      const owner = parent.status === 0 && parent.stdout.trim() ? JSON.parse(parent.stdout.trim()) : null;
      if (owner?.ExecutablePath?.toLowerCase() !== python.toLowerCase() || !owner.CommandLine?.includes('openbiliclaw.research.api:create_app')) throw new Error('虚拟环境归属不匹配，未停止。');
    }
    process.kill(existing.pid);
    console.log('研究工作台已停止，数据与浏览器保留。');
    process.exit(0);
  }
  if (!existing) {
    if (!existsSync(python)) throw new Error('研究工作台环境缺失：先按 local-workbench/SETUP.md 建好 .venv 并安装依赖。');
    const projectRoot = join(root,'home','.openbiliclaw');
    mkdirSync(projectRoot,{recursive:true});
    const configPath = join(projectRoot,'config.toml');
    // Only initialize absent configuration; never replace user settings.
    if (!existsSync(configPath)) writeFileSync(configPath, `# Local research defaults: no unsolicited collection or model traffic.
[general]
language = "zh-Hans"
data_dir = "${join(root,'data','openbiliclaw').replaceAll('\\','/')}"
[api]
host = "127.0.0.1"
port = 8766
[llm]
routing_version = 2
default_chain = []
[llm.sponsored]
enabled = false
[scheduler]
enabled = false
source_incremental_enabled = false
[sources.bilibili]
enabled = false
[sources.web]
enabled = false
`,{encoding:'utf8',flag:'wx'});
    const out = openSync(join(root, 'logs', 'research.stdout.log'), 'a');
    const err = openSync(join(root, 'logs', 'research.stderr.log'), 'a');
    let child;
    try {
      child = spawn(python, ['-m', 'uvicorn', 'openbiliclaw.research.api:create_app', '--factory', '--host', '127.0.0.1', '--port', '8766', '--no-access-log'], {
        cwd:appRoot, detached:true, stdio:['ignore',out,err], windowsHide:true,
        env:{...process.env, PYTHONPATH:join(appRoot,'src'), RESEARCH_WORKSPACE:root,
          PYTHONIOENCODING:'utf-8', PYTHONPYCACHEPREFIX:join(root,'.cache','python'),
          OPENBILICLAW_PROJECT_ROOT:projectRoot, OPENBILICLAW_FISH_LOOP_DISABLED:'1'},
      });
      await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
      child.unref();
    } finally { closeSync(out); closeSync(err); }
    let ready = false;
    for (let i = 0; i < 240; i++) {
      await new Promise(resolve => setTimeout(resolve,500));
      if (await status()) { ready = true; break; }
      if (child.exitCode !== null) throw new Error('工作台启动失败，请查看 logs/research.stderr.log。');
    }
    if (!ready) throw new Error('工作台尚未就绪，请查看日志；不要重复启动。');
  }
  console.log(`OpenBiliClaw 原生界面：${base}/web/#research`);
  console.log('登录统一在首页初始化清单、设置或研究页按钮，使用工作区 OpenBiliClaw 插件。研究模块无需 opencli。');
  if (!process.argv.includes('--no-open')) {
    const browser = spawn('rundll32.exe',['url.dll,FileProtocolHandler',pageUrl],{detached:true,stdio:'ignore',windowsHide:true});
    await new Promise((resolve,reject) => { browser.once('spawn',resolve); browser.once('error',reject); });
    browser.unref();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }




