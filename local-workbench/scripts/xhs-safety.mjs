import { createInterface } from 'node:readline/promises';
import { rateStatus, resumeAfterManualCheck } from './xhs-client.mjs';

try {
  if (!process.argv[2] || process.argv[2] === 'status') console.log(JSON.stringify(rateStatus(), null, 2));
  else if (process.argv[2] === 'resume') {
    if (!process.stdin.isTTY) throw new Error('解除暂停必须由用户在交互式终端确认。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('请先人工解决登录/验证/限流问题。确认后输入 RESUME；仍保留至少30分钟冷却和原有额度：');
    prompt.close();
    if (answer !== 'RESUME') throw new Error('未解除暂停。');
    console.log(JSON.stringify(resumeAfterManualCheck(), null, 2));
  } else throw new Error('用法：xhs-safety.cmd status|resume');
} catch (error) { console.error(error.message); process.exitCode = 1; }
