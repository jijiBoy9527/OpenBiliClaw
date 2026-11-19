import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
try {
  for (const name of readdirSync(join(root, 'patches')).filter(name => name.endsWith('.json'))) {
    const patch = JSON.parse(readFileSync(join(root, 'patches', name), 'utf8'));
    const target = join(root, patch.file);
    let source = readFileSync(target, 'utf8');
    if (hash(source) === patch.patchedSha256) {
      console.log(`补丁已安装：${name}`);
    } else {
      if (hash(source) !== patch.originalSha256) throw new Error('OpenCLI 适配器内容与固定版本不同，未覆盖文件。');
      for (const { before, after } of patch.replacements) {
        if (source.split(before).length !== 2) throw new Error('补丁匹配不唯一，未覆盖文件。');
        source = source.replace(before, after);
      }
      if (hash(source) !== patch.patchedSha256) throw new Error('补丁结果校验失败，未覆盖文件。');
      writeFileSync(target, source);
      console.log(`已应用补丁：${name}`);
    }
  }
  const adapterDir = join(root, 'home', '.opencli', 'clis', 'xiaohongshu');
  mkdirSync(adapterDir, { recursive: true });
  copyFileSync(join(root, 'adapters', 'xiaohongshu', 'keywords.js'), join(adapterDir, 'keywords.js'));
  console.log('已安装本地相关搜索词适配器。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
