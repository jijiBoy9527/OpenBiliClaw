/* Research workflows inside the unmodified OpenBiliClaw desktop shell. */
(() => {
  let controller;
  window.OpenBiliClawResearch = {
    enabled:false,
    async init(host) { controller = await initialize(host); },
    refresh() { return controller?.refresh(true); },
    open(link) { controller?.open(link); },
  };
  async function initialize(host) {
    const page = document.getElementById('researchPage');
    const $ = selector => page.querySelector(selector.replace(/^#/, '#research-'));
    const all = selector => page.querySelectorAll(selector);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const activeStates = new Set(['queued', 'running', 'stopping']);
    const states = {queued:'排队中',running:'执行中',stopping:'正在停止',completed:'范围完成',partial:'部分完成',failed:'执行失败',cancelled:'已停止',interrupted:'已中断',imported:'已有样本'};
    const kinds = {discover:'内容发现',collect:'评论采集',import:'已有样本',analyze:'评论整理'};
    const state = {jobs:[], current:null, tab:'contents', analysisDataset:null, selected:new Map(), offset:0, total:0, query:'', revision:0};
    let searchTimer, refreshing = false;

    function toast(message) { host.showToast(message); }
    async function api(path, options = {}) {
      // Research is local-only even if the desktop recommendation backend is remote.
      return host.requestJson(`/research${path}`, {...options, baseUrl:`${location.origin}/api`,
        headers:{'Content-Type':'application/json','X-Research-Request':'1',...options.headers}});
    }

    async function action(button, work) {
      if (button.disabled) return;
      button.disabled = true;
      try { await work(); } catch(error) { toast(error.message || '操作失败，请检查本机服务', true); }
      finally { button.disabled = false; if (button.id === 'research-collect-button') selectionState(); }
    }

    function badge(job) { return `<span class="chat-task-status is-${escape(({queued:"pending",partial:"interrupted",imported:"completed",cancelled:"interrupted",stopping:"running"})[job.state] || job.state)}">${escape(states[job.state] || job.state)}</span>`; }
    function date(value) { return new Date(value).toLocaleString('zh-CN', {hour12:false}); }
    function current() { return state.jobs.find(job => job.id === state.current); }
    function selection() {
      if (!state.selected.has(state.current)) state.selected.set(state.current, new Set());
      return state.selected.get(state.current);
    }
    function selectionState() {
      $('#selected-count').textContent = selection().size;
      $('#collect-button').disabled = !selection().size || activeStates.has(current()?.state);
    }

    function renderJobs() {
      const jobs = state.jobs;
      $('#jobs').innerHTML = jobs.length ? jobs.map(job => `<button class="chat-task-item ${job.id === state.current ? 'research-task-selected' : ''}" data-job="${escape(job.id)}" aria-pressed="${job.id === state.current}">
        <div class="chat-task-title-row">${kinds[job.kind] || escape(job.kind)} ${badge(job)}</div>
        <h3>${escape(job.title)}</h3><div class="video-meta">${escape(date(job.created_at))}<br>${job.counts.contents || 0} 篇内容 · ${job.counts.comments || 0} 条评论${job.counts.findings ? ` · ${job.counts.findings} 个发现` : ''}</div></button>`).join('') : '<p class="saved-empty">这里还没有数据。<br>新建研究，或导入已有样本。</p>';
      // 导航徽标不是所有构建都有；缺少时不能打断统计与记录渲染。
      const jobCount = document.getElementById('research-job-count');
      if (jobCount) {
        jobCount.textContent = state.jobs.length;
        jobCount.hidden = !state.jobs.length;
      }
      $('#stat-jobs').textContent = state.jobs.length;
      $('#stat-contents').textContent = state.jobs.reduce((sum, job) => sum + (job.counts.contents || 0), 0).toLocaleString();
      $('#stat-comments').textContent = state.jobs.reduce((sum, job) => sum + (job.counts.comments || 0), 0).toLocaleString();
      $('#stat-active').textContent = state.jobs.filter(job => activeStates.has(job.state)).length;
    }

    function renderDetail() {
      const job = current();
      $('#empty').hidden = Boolean(job);
      $('#detail').hidden = !job;
      if (!job) return;
      const source = job.kind === 'analyze' ? state.jobs.find(item => item.id === job.config.dataset_id) : job;
      $('#detail-title').textContent = job.title;
      $('#detail-meta').innerHTML = `${badge(job)} <span>${escape(job.id.slice(0,8))} / ${escape(date(job.created_at))}</span>`;
      $('#detail-message').textContent = job.message;
      $('#coverage-json').textContent = JSON.stringify({parameters:job.config,coverage:job.coverage},null,2);
      $('#stop-job').hidden = !activeStates.has(job.state);
      $('#export').hidden = activeStates.has(job.state);
      $('#contents-count').textContent = source?.counts.contents || 0;
      $('#comments-count').textContent = source?.counts.comments || 0;
      $('#findings-count').textContent = job.counts.findings || 0;
      const perNote = job.coverage.per_note || [];
      const limited = perNote.filter(note => note.truncated).length;
      const exhausted = perNote.filter(note => note.exhausted).length;
      $('#scope').textContent = job.kind === 'analyze'
        ? `分析 ${job.coverage.analyzed_comments || 0} / ${job.coverage.total_comments || source?.counts.comments || 0} 条评论。结果仅代表源数据集，证据 ID 可点开查看。`
        : `关键词相关或选定链接样本，不是精确标签筛选或平台全量。视频未转写。${perNote.length ? ` ${exhausted} 篇一级评论分页结束，${limited} 篇达到采样上限。` : ' 当前未确认全部分页覆盖。'}`;
      $('#collect-selection').hidden = state.tab !== 'contents' || job.kind === 'analyze';
      $('#analysis-open').hidden = job.kind === 'analyze';
      $('#analysis-open').disabled = activeStates.has(job.state) || !(job.counts.comments > 0);
      $('#record-search').hidden = state.tab === 'events';
      for (const tab of all('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
      selectionState();
    }

    async function renderRecords() {
      const job = current();
      if (!job) return;
      const revision = ++state.revision;
      if (state.tab === 'events') {
        const result = await api(`/jobs/${job.id}/events`);
        if (revision !== state.revision) return;
        $('#records').innerHTML = result.items.map(event => `<div class="chat-task-item"><time>${escape(date(event.time))}</time><span>${escape(event.message)}</span></div>`).join('') || '<p class="saved-empty">暂无任务记录</p>';
        $('#pagination').hidden = true;
        return;
      }
      const params = new URLSearchParams({kind:state.tab,q:state.query,offset:state.offset,limit:50});
      const result = await api(`/jobs/${job.id}/records?${params}`);
      if (revision !== state.revision) return;
      state.total = result.total;
      const selected = selection();
      if (state.tab === 'contents') {
        $('#records').innerHTML = result.items.map(item => `<article class="research-record research-selection">
          ${job.kind !== 'analyze' ? `<input type="checkbox" aria-label="选择 ${escape(item.title)}" data-select="${escape(item.content_id)}" ${!item.url ? 'disabled title="缺少完整来源链接，请重新发现"' : ''} ${selected.has(item.content_id) ? 'checked' : ''}>` : ''}
          <div class="chat-task-main"><h3>${escape(item.title)}</h3><div class="video-meta">${item.tags.filter(Boolean).map(tag => `<span class="chat-task-status"># ${escape(tag)}</span>`).join('')}</div>
          <p class="research-text">${escape(item.text)}</p><div class="video-meta drawer-actions"><span>${escape(item.content_id)}</span><span>赞 ${item.likes ?? '未知'}</span><span>平台显示评论 ${item.reported_comment_count ?? '未知'}</span><span>${item.type === 'video' ? '视频 · 未转写' : escape(item.type)}</span></div></div>
          ${item.url ? `<a class="small-btn" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer" title="保留采集时的完整访问参数；链接可能过期或受登录状态限制">原文 ↗</a>` : '<span class="video-meta">缺少完整来源链接，请重新发现</span>'}</article>`).join('');
      } else if (state.tab === 'comments') {
        $('#records').innerHTML = result.items.map(item => `<article class="research-record ${item.is_reply ? 'research-quote' : ''}">
          <div class="video-meta drawer-actions"><span class="chat-task-status">${item.is_reply ? '回复' : '一级评论'}</span><span>${escape(item.comment_id)}</span><span>赞 ${item.likes ?? '未知'}</span></div>
          <p>${escape(item.text || '（无文本）')}</p><details><summary>查看关联与时间</summary>内容 ID：${escape(item.content_id)}<br>父评论：${escape(item.parent_comment_id || '无')}<br>根评论：${escape(item.root_comment_id || '未知，未猜测')}<br>发布时间（平台原值）：${escape(item.published_at_raw)}<br>采集时间：${escape(item.collected_at)}</details></article>`).join('');
      } else {
        $('#records').innerHTML = result.items.map(item => `<article class="research-record"><span class="chat-task-status">${escape(item.category)}</span><h3>${escape(item.summary)}</h3><p class="video-meta">证据评论（点击查看原文）</p>${item.evidence_comment_ids.map(id => `<button class="small-btn" data-evidence="${escape(id)}">${escape(id)}</button>`).join('')}<p class="video-meta">${escape(item.model)} · ${escape(item.analysis_version)}</p></article>`).join('');
      }
      if (!result.items.length) $('#records').innerHTML = `<p class="saved-empty">${state.query ? '没有匹配的数据。' : state.tab === 'findings' ? '还没有分析结果。原始数据可以直接导出，不必先经过 AI。' : activeStates.has(job.state) ? '等待采集写入，页面会自动更新。' : '这批任务没有此类数据。'}</p>`;
      $('#pagination').hidden = false;
      $('#page-label').textContent = `${result.total ? state.offset + 1 : 0}–${Math.min(state.offset + 50,result.total)} / ${result.total} 条`;
      $('#previous').disabled = state.offset === 0;
      $('#next').disabled = state.offset + 50 >= result.total;
    }

    async function refresh(forceRecords = false) {
      if (refreshing) return;
      refreshing = true;
      try {
        const before = JSON.stringify(current());
        const result = await api('/jobs');
        state.jobs = result.items;
        if (!state.current && state.jobs.length) state.current = state.jobs[0].id;
        renderJobs();
        renderDetail();
        if (forceRecords || before !== JSON.stringify(current()) || activeStates.has(current()?.state)) await renderRecords();
        $('#connection').textContent = '● 本机服务已连接 · 登录复用平台源中的小红书';
      } catch(error) {
        $('#connection').textContent = `连接失败：${error.message}`;
        if (forceRecords) toast(error.message,true);
      } finally { refreshing = false; }
    }

    async function chooseJob(id) {
      state.current = id;
      state.offset = 0;
      state.query = '';
      $('#record-search').value = '';
      state.tab = current()?.kind === 'analyze' ? 'findings' : 'contents';
      renderJobs(); renderDetail(); await renderRecords();
    }

    async function showSubmitted(job) {
      if (!state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
      await chooseJob(job.id);
      await refresh();
    }

    function newDialog() { host.openPanel('research-new-dialog'); }
    $('#new-job').addEventListener('click',newDialog);
    $('#empty-create').addEventListener('click',newDialog);
    for (const button of all('[data-research-close]')) button.addEventListener('click',() => host.closePanel(`research-${button.dataset.researchClose}`));
    $('#jobs').addEventListener('click',event => {
      const button = event.target.closest('[data-job]');
      if (button) chooseJob(button.dataset.job).catch(error => toast(error.message,true));
    });
    for (const tab of all('[data-tab]')) tab.addEventListener('click',() => {
      state.tab = tab.dataset.tab; state.offset = 0;
      renderDetail(); renderRecords().catch(error => toast(error.message,true));
    });
    $('#records').addEventListener('change',event => {
      if (!event.target.matches('[data-select]')) return;
      const selected = selection(), id = event.target.dataset.select;
      event.target.checked ? selected.add(id) : selected.delete(id);
      selectionState();
    });
    $('#records').addEventListener('click',event => {
      const evidence = event.target.closest('[data-evidence]');
      if (!evidence) return;
      state.tab = 'comments'; state.query = evidence.dataset.evidence; state.offset = 0;
      $('#record-search').value = state.query;
      renderDetail(); renderRecords().catch(error => toast(error.message,true));
    });
    $('#record-search').addEventListener('input',event => {
      clearTimeout(searchTimer);
      const query = event.target.value;
      searchTimer = setTimeout(() => { state.query = query; state.offset = 0; renderRecords().catch(error => toast(error.message,true)); },250);
    });
    for (const [id, direction] of [['previous',-1],['next',1]]) $(`#${id}`).addEventListener('click',() => {
      state.offset = Math.max(0,state.offset + direction * 50);
      renderRecords().catch(error => toast(error.message,true));
    });
    $('#refresh').addEventListener('click',() => refresh(true));
    $('#import-existing').addEventListener('click',event => action(event.currentTarget,async () => {
      const result = await api('/import',{method:'POST'});
      toast(result.imported.length ? `已导入 ${result.imported.length} 批样本` : '已有采集批次均已入库，没有重复导入');
      await refresh(true);
    }));
    $('#browser-open').addEventListener('click',event => action(event.currentTarget,async () => {
      await host.openXhsLogin();
    }));
    $('#stop-job').addEventListener('click',event => action(event.currentTarget,async () => {
      await api(`/jobs/${state.current}/stop`,{method:'POST'}); await refresh(true);
    }));
    $('#new-form').addEventListener('change',() => {
      const direct = new FormData($('#new-form')).get('mode') === 'collect';
      $('#discovery-fields').hidden = direct; $('#direct-fields').hidden = !direct;
    });
    $('#new-form').addEventListener('submit',event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget), mode = values.get('mode');
      action(event.submitter,async () => {
        const data = {topic:values.get('topic').trim(),interval:Number(values.get('interval'))};
        if (mode === 'discover') data.max_notes = Number(values.get('max_notes'));
        else Object.assign(data,{urls:values.get('urls').split(/\r?\n/).map(line => line.trim()).filter(Boolean),max_comments:Number(values.get('max_comments')),include_replies:values.has('include_replies')});
        const job = await api(mode === 'discover' ? '/discover' : '/collect',{method:'POST',body:JSON.stringify(data)});
        host.closePanel('research-new-dialog'); await showSubmitted(job); toast('已加入队列，可以在这里查看进度');
      });
    });
    $('#collect-selection').addEventListener('submit',event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      action(event.submitter,async () => {
        const selected = [...selection()];
        if (selected.length > 10) throw new Error('单批最多选择 10 篇内容，请减少选择');
        const job = await api('/collect',{method:'POST',body:JSON.stringify({topic:current().config.topic || current().title,
          source_dataset_id:state.current,content_ids:selected,max_comments:Number(values.get('max_comments')),
          include_replies:values.has('include_replies'),interval:Number(values.get('interval'))})});
        await showSubmitted(job); toast('评论采集已排队，原候选数据保留不变');
      });
    });
    $('#model-open').addEventListener('click',event => action(event.currentTarget,async () => {
      const config = await api('/model'), form = $('#model-form');
      form.elements.namedItem('base_url').value = config.base_url;
      form.elements.namedItem('model').value = config.model;
      form.elements.namedItem('api_key').value = '';
      form.elements.namedItem('clear_key').checked = false;
      $('#key-state').textContent = config.has_key ? '已保存受保护的密钥；留空不会覆盖。' : '尚未保存密钥；本机免密模型可留空。';
      host.openPanel('research-model-dialog');
    }));
    $('#model-form').addEventListener('submit',event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      action(event.submitter,async () => {
        await api('/model',{method:'PUT',body:JSON.stringify({base_url:values.get('base_url').trim(),model:values.get('model').trim(),api_key:values.get('api_key'),clear_key:values.has('clear_key')})});
        $('#model-form').elements.namedItem('api_key').value = '';
        host.closePanel('research-model-dialog'); toast('模型设置已保存，没有发送评论或产生模型请求');
      });
    });
    $('#analysis-open').addEventListener('click',event => action(event.currentTarget,async () => {
      const dataset = current();
      const config = await api('/model');
      if (!config.base_url || !config.model) { $('#model-open').click(); toast('请先保存模型设置；原始数据仍可直接导出'); return; }
      $('#analysis-destination').textContent = `目标服务：${config.base_url}；模型：${config.model}；当前数据集：${dataset.counts.comments || 0} 条评论。`;
      state.analysisDataset = dataset.id;
      $('#analysis-form').elements.namedItem('consent').checked = false;
      host.openPanel('research-analysis-dialog');
    }));
    $('#analysis-form').addEventListener('submit',event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      action(event.submitter,async () => {
        const job = await api('/analyze',{method:'POST',body:JSON.stringify({dataset_id:state.analysisDataset,goal:values.get('goal'),consent:values.has('consent')})});
        host.closePanel('research-analysis-dialog'); await showSubmitted(job); toast('分析已排队；结果另存，不覆盖评论');
      });
    });

    $('#export').addEventListener('click',event => action(event.currentTarget,async () => {
      const jobId = state.current;
      const response = await fetch(`/api/research/jobs/${encodeURIComponent(jobId)}/export`, {
        credentials:'same-origin', headers:{'X-OBC-Auth':'1','X-Research-Request':'1'}, signal:AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(typeof result?.detail === 'string' ? result.detail : `导出失败（HTTP ${response.status}）`);
      }
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = `research-${jobId.slice(0,8)}.zip`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url),60000);
    }));

    await api('/status');
    window.OpenBiliClawResearch.enabled = true;
    document.documentElement.dataset.research = 'enabled';
    // 研究页入口已从导航移除：推荐与研究是同一条流水线的同一页（首页内容流接管）。
    // 旧页面保留仅作兜底，不再提供任何跳转入口。
    const workbenchBtn = document.getElementById('researchWorkbenchBtn');
    if (workbenchBtn) workbenchBtn.hidden = false;
    setInterval(() => { if (!page.hidden && !document.hidden) void refresh(); },3000);
    document.addEventListener('visibilitychange',() => { if (!page.hidden && !document.hidden) void refresh(true); });
    return {refresh, open(link) {
      host.openPage();
      const form = $('#new-form');
      form.elements.namedItem('mode').value = 'collect';
      form.elements.namedItem('topic').value = '选定内容研究';
      form.elements.namedItem('urls').value = link;
      form.dispatchEvent(new Event('change'));
      newDialog();
    }};
  }
})();
