import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment.mjs';
import { policy, withXhsClient } from './xhs-client.mjs';
import { analyzeResearch } from './analyze-xhs.mjs';
import { collectNoteComments, commentScope } from './xhs-comments.mjs';

const [seed = '推拿', ...flags] = process.argv.slice(2);
const reuse = flags.length === 1 && flags[0] === '--reuse-seed-page';
const runAt = new Date().toISOString().replace(/[:.]/g, '-');
const output = join(root, 'data', 'xiaohongshu', `research-${runAt}`);
let manifest;
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');

function classify(term) {
  if (/招聘|招人|照片/.test(term)) return { category: '非本次内容研究', priority: 0 };
  if (/肩颈|腰背|放松|酸痛|疼痛/.test(term)) return { category: '身体部位与放松需求', priority: 3 };
  if (/推荐|体验|避雷|价格|多少钱|附近/.test(term)) return { category: '消费决策与体验', priority: 2 };
  if (/教学|手法|跟练|教程/.test(term)) return { category: '学习与手法内容', priority: 1 };
  return { category: '其他相关词（本批不扩展）', priority: 0 };
}

try {
  if (!seed.trim() || (flags.length && !reuse)) throw new Error('用法：research-xhs.cmd "推拿" [--reuse-seed-page]');
  mkdirSync(output, { recursive: true });
  manifest = { seed, startedAt: new Date().toISOString(), status: 'discovering', policy,
    plan: { maxTerms: 3, notesPerTerm: 3, detailsPerTerm: 1, sort: 'most-liked', publishTime: 'anytime', recursiveExpansion: false, comments: commentScope },
    counts: { terms: 0, searches: 0, uniqueSearchNotes: 0, details: 0, commentsNotes: 0 }, reusedSeedPage: reuse };
  save('manifest.json', manifest);
  await withXhsClient(async run => {
    const xhs = args => run(['xiaohongshu', ...args, '-f', 'json']);
    if (!reuse) {
      console.log(`先搜索种子词“${seed}”，只读取5条列表，不展开详情。`);
      save('seed-search.json', await xhs(['search', seed, '--limit', '5']));
    }
    console.log('读取当前搜索页展示的相关搜索词，不触发二级扩展。');
    const discovered = await xhs(['keywords', seed]);
    save('keywords-raw.json', discovered);
    const terms = discovered.data.terms.map(item => ({ ...item, ...classify(item.term),
      query: item.term.includes(seed) ? item.term : `${seed} ${item.term}`, selected: false }));
    const selected = [...terms].filter(item => item.priority > 0)
      .sort((a, b) => b.priority - a.priority || a.displayOrder - b.displayOrder).slice(0, 3);
    if (!selected.length) throw new Error('平台相关词中没有符合本批研究意图的词，停止；不会编造关键词继续搜索。');
    for (const item of selected) item.selected = true;
    save('keywords-analysis.json', { source: discovered.data.source, note: discovered.data.note, terms,
      selectionReason: '先部位需求，再消费决策，最后手法学习；同类按平台展示顺序，不是热度排名。' });
    const groups = [], notes = [], seen = new Set();
    save('searches.json', groups);
    save('notes.json', notes);
    manifest.counts.terms = terms.length;
    manifest.selectedQueries = selected.map(item => item.query);
    manifest.status = 'searching'; save('manifest.json', manifest);
    analyzeResearch(output);
    const candidates = [];
    for (const term of selected) {
      console.log(`搜索“${term.query}”：按点赞排序，最多3条，不翻页扩展。`);
      const result = await xhs(['search', term.query, '--sort', 'most-liked', '--limit', '3']);
      if (!Array.isArray(result.data)) throw new Error('笔记搜索返回结构不匹配，停止。');
      groups.push({ query: term.query, sourceTerm: term.term, items: result.data });
      manifest.counts.searches++;
      for (const item of result.data) {
        const url = new URL(item.url);
        const id = url.pathname.match(/^\/(?:search_result|explore|note)\/([0-9a-f]{24})\/?$/i)?.[1];
        if (url.protocol !== 'https:' || !['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) || !id || !url.searchParams.get('xsec_token')) {
          throw new Error('搜索结果缺少完整有效笔记链接，停止，避免请求错误页面。');
        }
        if (!seen.has(id)) {
          seen.add(id); candidates.push({ id, query: term.query, search: item });
        }
      }
      manifest.counts.uniqueSearchNotes = seen.size;
      save('searches.json', groups); save('manifest.json', manifest);
      analyzeResearch(output);
    }
    // Finish keyword searches first; read just one unique note per query.
    // Shared detail notes are never requested twice within this batch.
    manifest.status = 'reading'; save('manifest.json', manifest);
    for (const term of selected) {
      const candidate = candidates.find(item => item.query === term.query);
      if (!candidate) continue;
      console.log(`读取1篇样例正文：${candidate.search.title}`);
      const result = await xhs(['note', candidate.search.url]);
      notes.push({ ...candidate, detail: result.data, collectedAt: new Date().toISOString() });
      manifest.counts.details = notes.length;
      save('notes.json', notes); save('manifest.json', manifest);
      analyzeResearch(output);
    }
    manifest.status = 'reading-comments'; save('manifest.json', manifest);
    for (const note of notes) {
      await collectNoteComments(run, output, note);
      manifest.counts.commentsNotes++;
      save('manifest.json', manifest); analyzeResearch(output);
    }
    manifest.status = 'completed'; manifest.finishedAt = new Date().toISOString();
    save('manifest.json', manifest);
    analyzeResearch(output);
    console.log(`已完成，结果保存在：${output}`);
  });
} catch (error) {
  if (manifest) {
    manifest.status = 'stopped'; manifest.finishedAt = new Date().toISOString(); save('manifest.json', manifest);
    save('error.json', { message: error.message, detail: error.detail, at: new Date().toISOString(),
      note: '已停止，不自动重试；已采集结果保留。' });
    const reportPath = join(output, '分析报告.md');
    const stopped = `\n\n## 本批已停止\n\n${error.message}\n\n已采集结果保留，不自动重试。\n`;
    if (existsSync(reportPath)) appendFileSync(reportPath, stopped);
    else writeFileSync(reportPath, stopped.trimStart());
  }
  console.error(error.message);
  if (manifest) console.error(`本批记录：${output}`);
  process.exitCode = 1;
}
