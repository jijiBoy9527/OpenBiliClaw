import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const commentScope = Object.freeze({ maxTopLevel: 5, maxExpansionClicksPerNote: 2,
  expansionGapSeconds: [12, 15], autoScroll: false, allComments: false, allReplies: false });
const save = (directory, name, data) => writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + '\n');
export function readComments(directory) {
  const file = join(directory, 'comments.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}
export function commentThreads(rows) {
  const threads = [];
  for (const row of rows) {
    if (!row.is_reply) threads.push({ comment: row, replies: [] });
    else {
      if (!threads.length) throw new Error('评论返回了没有顶层楼的回复，停止保存。');
      threads.at(-1).replies.push(row);
    }
  }
  return threads;
}
export function writeCommentReport(directory) {
  const items = readComments(directory);
  const lines = ['# 评论与楼中楼采集', '',
    '范围：每篇已加载首批前5条顶层评论及其已渲染回复；每篇最多点击2次展开，不滚动、不追完回复。不是全部评论或全部楼中楼。',
    '分楼依据上游DOM输出顺序，不是平台comment_id；回复目标为页面显示的昵称，不能据此唯一识别用户或恢复精确回复链。内容为用户原话，可能含夸张疗效表述，不作医学结论。', ''];
  for (const item of items) {
    lines.push(`## ${item.title}`, '', `采集于 ${item.collectedAt}｜顶层 ${item.topLevelCount} 条｜楼中楼 ${item.replyCount} 条`, '');
    for (const [index, thread] of commentThreads(item.rows).entries()) {
      const c = thread.comment;
      lines.push(`### 第 ${index + 1} 楼`, '', `作者：${c.author}｜点赞 ${c.likes}｜${c.time}`, '', c.text, '');
      for (const r of thread.replies) lines.push(`- ${r.author} → ${r.reply_to}｜点赞 ${r.likes}｜${r.time}：${r.text}`);
      lines.push('');
    }
  }
  writeFileSync(join(directory, '评论报告.md'), lines.join('\n'));
}
export async function collectNoteComments(run, directory, note) {
  const id = note.id || note.noteId;
  const items = readComments(directory);
  if (items.some(item => item.noteId === id)) {
    console.log(`保留已采评论，不重复访问：${note.search.title}`);
    return;
  }
  const raw = note.search.url;
  const url = new URL(raw);
  const parsedId = url.pathname.match(/^\/(?:search_result|explore|note)\/([0-9a-f]{24})\/?$/i)?.[1];
  if (url.protocol !== 'https:' || !['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname)
    || parsedId !== id || !url.searchParams.get('xsec_token')) throw new Error('评论采集缺少与笔记对应的完整签名链接，停止。');
  console.log(`读取评论和楼中楼：${note.search.title}`);
  const result = await run(['xiaohongshu', 'comments', raw, '--with-replies', '--limit', '5', '-f', 'json']);
  if (!Array.isArray(result.data)) throw new Error('评论返回结构不符，停止。');
  const threads = commentThreads(result.data);
  if (threads.length > 5) throw new Error('评论数量超出本批范围，停止。');
  items.push({ noteId: id, title: note.search.title, query: note.query,
    collectedAt: new Date().toISOString(), scope: commentScope,
    topLevelCount: threads.length, replyCount: result.data.length - threads.length, rows: result.data });
  save(directory, 'comments.json', items);
  writeCommentReport(directory);
  console.log(`已保存：顶层 ${threads.length} 条，楼中楼 ${result.data.length - threads.length} 条。`);
}
