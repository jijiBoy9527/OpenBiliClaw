import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

// Only inspect the already-rendered search refinement bar. No API replay,
// scrolling, clicking, or synthetic keyword generation happens in this adapter.
cli({
  site: 'xiaohongshu', name: 'keywords', access: 'read',
  description: '读取当前同词搜索页真实展示的相关搜索词（非官方热搜榜）',
  domain: 'www.xiaohongshu.com', strategy: Strategy.COOKIE, navigateBefore: false,
  args: [{ name: 'query', positional: true, required: true, help: 'Must match the current search page keyword' }],
  func: async (page, args) => {
    const result = await page.evaluate(`(() => {
      const seed = ${JSON.stringify(args.query)};
      const visible = element => {
        if (!element || element.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.01) return false;
        }
        return true;
      };
      const body = document.body?.innerText || '';
      if (location.pathname.startsWith('/website-login/') || /请求太频繁|访问频次异常|安全限制|访问链接异常|请完成验证/.test(body)) return { error: 'SECURITY_BLOCK' };
      if (visible(document.querySelector('#login-btn')) || /登录后查看搜索结果/.test(body)) return { error: 'AUTH_REQUIRED' };
      let query = new URLSearchParams(location.search).get('keyword');
      try { query = decodeURIComponent(query); } catch {}
      if (!['/search_result', '/search_result_ai'].includes(location.pathname) || query !== seed) return { error: 'WRONG_PAGE' };
      const terms = [], seen = new Set();
      for (const element of document.querySelectorAll('.content-container > button.tab')) {
        if (!visible(element)) continue;
        const term = element.textContent.replace(/\\s+/g, ' ').trim();
        if (!term || term === '综合' || seen.has(term)) continue;
        seen.add(term);
        terms.push({ term, displayOrder: terms.length + 1 });
      }
      return { keyword: seed, source: 'search-refinement-bar', sourceUrl: location.href,
        observedAt: new Date().toISOString(), terms,
        note: '平台当前搜索页的相关词，展示顺序不是搜索量或官方热度排名，可能受账号和位置影响。' };
    })()`);
    if (result?.error === 'SECURITY_BLOCK') throw new CliError('SECURITY_BLOCK', '小红书显示验证或访问限制，停止读取。');
    if (result?.error === 'AUTH_REQUIRED') throw new AuthRequiredError('www.xiaohongshu.com', '请人工登录后再操作。');
    if (result?.error) throw new CommandExecutionError('当前页面不是指定关键词的搜索页；先运行同词 search，再读取 keywords。');
    if (!Array.isArray(result?.terms)) throw new CommandExecutionError('相关词结构异常，未生成替代关键词。');
    if (!result.terms.length) throw new EmptyResultError('xiaohongshu keywords', '当前页面未显示可读取的相关搜索词。');
    return result;
  },
});
