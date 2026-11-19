import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { root } from './environment.mjs';
import { withXhsClient, policy } from './xhs-client.mjs';
import { collectNoteComments, commentScope, readComments, writeCommentReport } from './xhs-comments.mjs';
import { analyzeResearch } from './analyze-xhs.mjs';

let directory, manifest;
const save = () => writeFileSync(join(directory, 'comments-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
try {
  if (process.argv.length !== 3) throw new Error('用法：collect-xhs-comments.cmd "已有采集目录"');
  directory = resolve(process.argv[2]);
  const rel = relative(join(root, 'data', 'xiaohongshu'), directory);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('仅允许工作区 data/xiaohongshu 内的采集目录。');
  const notes = JSON.parse(readFileSync(join(directory, 'notes.json'), 'utf8'));
  const research = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).seed;
  manifest = { startedAt: new Date().toISOString(), status: 'reading', scope: commentScope, policy, plannedNotes: notes.length };
  save();
  await withXhsClient(async run => {
    for (const note of notes) {
      await collectNoteComments(run, directory, note);
      manifest.completedNotes = readComments(directory).length; save();
      if (research) analyzeResearch(directory);
    }
  });
  manifest.status = 'completed'; manifest.finishedAt = new Date().toISOString(); save();
  writeCommentReport(directory);
  console.log(`完成：${directory}`);
} catch (error) {
  if (manifest) {
    manifest.status = 'stopped'; manifest.error = error.message;
    manifest.finishedAt = new Date().toISOString(); save();
  }
  console.error(error.message); process.exitCode = 1;
}
