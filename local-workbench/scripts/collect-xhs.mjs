import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment.mjs';
import { withXhsClient } from './xhs-client.mjs';
import { collectNoteComments, commentScope } from './xhs-comments.mjs';

let output;
let manifest;
const [keyword, rawLimit = '5', ...extra] = process.argv.slice(2);
try {
  const limit = Number(rawLimit);
  if (!keyword?.trim() || !Number.isInteger(limit) || limit < 1 || limit > 20 || extra.length) {
    throw new Error('用法：collect-xhs.cmd "关键词" [数量1-20，默认5]');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  output = join(root, 'data', 'xiaohongshu', stamp);
  mkdirSync(output, { recursive: true });
  const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n');
  manifest = {
    keyword, limit, source: 'xiaohongshu-search',
    sort: 'most-liked', publishTime: 'week',
    startedAt: new Date().toISOString(), status: 'searching',
    note: '关键词最近一周按点赞排序的搜索结果，不是小红书官方全站热榜。',
    commentScope,
  };
  save('manifest.json', manifest);
  console.log(`搜索“${keyword}”：最近一周，按点赞排序，最多 ${limit} 篇。`);
  await withXhsClient(async run => {
    const runCli = args => run(['xiaohongshu', ...args, '-f', 'json']);
    const search = await runCli(['search', keyword, '--sort', 'most-liked', '--publish-time', 'week', '--limit', String(limit)]);
    save('search.json', search);
    if (!Array.isArray(search.data)) throw new Error('搜索结果结构与已部署 OpenCLI 契约不一致；已保留原始结果。');
    const notes = [];
    const seen = new Set();
    manifest.status = 'reading';
    save('manifest.json', manifest);
    for (const item of search.data) {
      const url = new URL(item.url);
      const noteId = url.pathname.match(/^\/(?:search_result|explore|note)\/([0-9a-f]{24})\/?$/i)?.[1];
      if (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) || !noteId || !url.searchParams.get('xsec_token')) {
        throw new Error('搜索结果缺少带 xsec_token 的有效笔记链接，停止读取；已保留原始搜索结果。');
      }
      if (seen.has(noteId)) continue;
      seen.add(noteId);
      console.log(`读取 ${notes.length + 1}/${search.data.length}：${item.title}`);
      const detail = await runCli(['note', item.url]);
      notes.push({ noteId, url: item.url, search: item, detail: detail.data, collectedAt: new Date().toISOString() });
      save('notes.json', notes);
      await collectNoteComments(run, output, notes.at(-1));
    }
    save('manifest.json', { ...manifest, status: 'completed', collected: notes.length, finishedAt: new Date().toISOString() });
    console.log(`已保存 ${notes.length} 篇笔记：${output}`);
  });
} catch (error) {
  if (output) {
    if (manifest) writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...manifest,
      status: 'failed', finishedAt: new Date().toISOString() }, null, 2) + '\n');
    writeFileSync(join(output, 'error.json'), JSON.stringify({ status: 'failed',
      message: error.message, detail: error.detail, at: new Date().toISOString(),
      note: '采集已停止，不会绕过登录、验证码或访问限制；已读取的内容保留在本目录。',
    }, null, 2));
  }
  console.error(error.message);
  if (output) console.error(`本次记录：${output}`);
  process.exitCode = 1;
}
