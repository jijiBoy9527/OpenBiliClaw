import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readComments, writeCommentReport } from './xhs-comments.mjs';

function likesNumber(raw) {
  const match = String(raw).replaceAll(',', '').trim().match(/^(\d+(?:\.\d+)?)(万|亿|[wWkK])?\+?$/);
  if (!match) return null;
  const factors = { '万': 10_000, '亿': 100_000_000, w: 10_000, k: 1000 };
  return Math.round(Number(match[1]) * (match[2] ? factors[match[2].toLowerCase()] : 1));
}

export function analyzeResearch(directory) {
  const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const manifest = read('manifest.json');
  const analysis = read('keywords-analysis.json');
  const groups = read('searches.json');
  const notes = read('notes.json');
  const comments = readComments(directory);
  const metrics = groups.map(group => {
    const likes = group.items.map(item => likesNumber(item.likes));
    const allKnown = likes.length > 0 && likes.every(value => value !== null);
    return { query: group.query, sourceTerm: group.sourceTerm, sampleSize: group.items.length,
      sampleLikes: allKnown ? likes.reduce((sum, value) => sum + value, 0) : null,
      maximumLikes: likes.some(value => value !== null) ? Math.max(...likes.filter(value => value !== null)) : null,
      items: group.items.map(item => ({ title: item.title, likes: item.likes })) };
  });
  writeFileSync(join(directory, 'keywords-validation.json'), JSON.stringify({ metrics,
    note: '只比较本次各搜索条件下首屏小样本点赞展示值，不能当作搜索量、官方热度或领域趋势。不同词结果可能重叠，不能跨词求总互动。' }, null, 2));
  const lines = [
    `# ${manifest.seed}：相关搜索词与笔记分析`, '',
    `状态：${manifest.status}｜相关词 ${analysis.terms.length} 个｜搜索 ${groups.length} 个方向｜正文 ${notes.length} 篇｜已采评论的笔记 ${comments.length} 篇`, '',
    '## 来源与范围', '',
    '相关词来自小红书实际搜索页的细分标签栏，不是官方热搜榜，平台没有提供这些词的搜索量。结果可能受账号和地域影响。',
    '选词依据：优先部位需求，其次消费决策，最后手法学习；同类按平台展示顺序。只扩展3词，每词最多3条笔记列表和1篇正文，不递归扩词、不滚动加载。', '',
    '## 抓到的相关词', '', '| 展示序号 | 平台原词 | 内容分类 | 是否扩展 |', '| --- | --- | --- | --- |',
    ...analysis.terms.map(term => `| ${term.displayOrder} | ${term.term} | ${term.category} | ${term.selected ? term.query : '否'} |`), '',
    '## 样本互动对比', '', '| 实际搜索词 | 笔记样本数 | 样本点赞合计（近似） | 单篇最高点赞（近似） |', '| --- | --- | --- | --- |',
    ...metrics.map(item => `| ${item.query} | ${item.sampleSize} | ${item.sampleLikes ?? '无法解析'} | ${item.maximumLikes ?? '无法解析'} |`), '',
    '**这只是搜索结果小样本对比，不是真实词热度排名。** 发布时间不限；没有历史增长率或近期趋势数据。', '',
  ];
  const strongest = metrics.filter(item => item.maximumLikes !== null).sort((a, b) => b.maximumLikes - a.maximumLikes)[0];
  lines.push('## 内容研究观察', '');
  if (strongest) lines.push(`- 本批单篇点赞展示值最高的方向是“${strongest.query}”，约 ${strongest.maximumLikes}；说明该检索能找到高互动内容，不等于这个词的搜索需求最大。`);
  lines.push('- 部位需求词适合观察用户痛点；消费决策词适合门店体验和推荐研究；手法学习词适合教程选题。分类是研究判断，不是平台标签。',
    '- 本批没有扩展城市词，因此不代表任何单一城市的门店竞争情况；也不能把这些不限时间的历史内容当作近期增长趋势。',
    '- 列表和详情互动数分别保留原值，例如列表可能显示具体万位数、详情显示“10万+”；不强行合并为精确数值。', '',
    '以下为原笔记标题和正文，可能含夸张或未经证实的疗效表述，仅作内容研究，不代表医学事实。', '');
  for (const group of groups) {
    lines.push(`## ${group.query}`, '');
    for (const item of group.items) lines.push(`- ${item.title}｜点赞 ${item.likes}｜${item.author}`);
    lines.push('');
  }
  lines.push('## 正文样例', '');
  for (const item of notes) {
    const detail = Object.fromEntries(item.detail.map(field => [field.field, field.value]));
    lines.push(`### ${detail.title || item.search.title}`, '',
      `来自搜索：${item.query}｜点赞 ${detail.likes}｜收藏 ${detail.collects}｜评论 ${detail.comments}`, '',
      '> 下文为原笔记正文，只作内容研究，不代表医学疗效已经证实，也不是推拿操作或诊疗建议。', '', detail.content || '（该笔记没有文字正文）', '');
  }
  lines.push('## 评论与楼中楼', '',
    '每篇取已加载首批前5条顶层评论及对应已渲染楼中楼，每篇最多展开2次，间隔12–15秒；不滚动、不追完回复。不是全部评论或全部楼中楼。', '',
    '| 笔记 | 实际顶层评论 | 实际楼中楼 |', '| --- | --- | --- |',
    ...comments.map(item => `| ${item.title} | ${item.topLevelCount} | ${item.replyCount} |`), '',
    comments.length ? '评论原话、作者昵称、点赞、时间和页面回复目标见同目录《评论报告.md》；原始字段见 comments.json。分楼按DOM顺序整理，不是平台comment_id，也不能仅凭昵称唯一识别回复对象。' : '本批尚未成功获取评论文字。', '',
    '小样本且受页面排序影响，不能代表全部用户意见；评论中的疗效说法不作医学事实。', '');
  if (comments.length) writeCommentReport(directory);
  lines.push('## 速率与限制', '',
    '命令完成后等待60–90秒；全局互斥、每小时12次、滚动24小时40次。筛选条件变化之间另等待12秒。原始HTTP请求（页面资源和站点内部API）数量不等同于命令数量，不能保证不触发风控。',
    '异常立即暂停，保留已完成结果，不自动重试；原始链接仅存本地JSON。未下载媒体、未采集全部评论、未转写视频；published_at 为上游按笔记ID推算日期，并非官方发布时间字段。', '');
  writeFileSync(join(directory, '分析报告.md'), lines.join('\n'));
  return metrics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(analyzeResearch(resolve(process.argv[2])), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
