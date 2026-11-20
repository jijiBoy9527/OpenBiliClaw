/**
 * 首页推荐流里的「主题补充」能力。
 *
 * 与「为你推荐的内容」是同一个流，不是第二个板块：
 * - 默认按画像推荐（由 app.js 渲染）；
 * - 顶部输入主题 → 插件在小红书页面内只找这类内容 → 卡片接在推荐卡后面；
 * - 每张卡都能「看评论」，评论必须二次确认才采。
 */
(() => {
  const BASE = "/api/feed";
  const state = { items: [], busy: false, pollTimer: null, openId: null, jobId: null, topic: "" };

  const $ = (sel) => document.querySelector(sel);

  async function api(path, options = {}) {
    const response = await fetch(BASE + path, {
      headers: { "X-Research-Request": "1", "Content-Type": "application/json" },
      ...options,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail = body.detail || body.error || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    return response.json();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  // 失败信息里如果只是"未收到小红书登录态"，用户不知道该去哪里登录。
  // 这里把可点的登录入口直接放进状态行，点开就是工作区那个登录窗口。
  function needsLogin(text) {
    return /登录态|未登录|插件未连接|请连接/.test(String(text || ""));
  }

  function setStatus(text, options = {}) {
    const node = $("#feedStatus");
    if (!node) return;
    node.textContent = text || "";
    if (!text || !options.login) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill-btn small";
    button.textContent = "打开小红书登录";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (typeof window.__obcOpenXhsLogin === "function") {
        window.__obcOpenXhsLogin();
      } else {
        setStatus("登录入口暂不可用：请刷新页面后重试。");
      }
    });
    node.append(" ", button);
  }

  // 主题内容与推荐内容必须是同一张卡片：同样的点赞/评论/收藏统计、反馈按钮、
  // 收藏 / 稍后再看 / 聊一聊。研究记录里只有 content_id，这里映射成推荐卡的字段。
  function toRecommendationItem(item) {
    const contentId = String(item.content_id || "");
    const itemKey = contentId ? `xiaohongshu:${contentId}` : "";
    const summary = item.summary_b || item.summary || "";
    return {
      id: null,
      bvid: itemKey,
      item_key: itemKey,
      content_id: contentId,
      content_url: item.url || "",
      title: item.title || "无标题",
      up: item.author || "",
      up_name: item.author || "",
      platform: "xiaohongshu",
      source_platform: "xiaohongshu",
      cover_url: item.cover_url || "",
      like_count: Number(item.likes || 0),
      favorite_count: Number(item.favorite_count || 0),
      share_count: Number(item.share_count || 0),
      comment_count: Number(item.reported_comment_count || 0),
      view_count: 0,
      topic_label: item.topic || "",
      reason: summary,
      expression: summary,
      content_type: "note",
      published_at: "",
      duration: 0,
      source_rank: 0,
    };
  }

  // 兜底：旧构建没有卡片工厂时，用简化卡片，功能不能断。
  function cardMarkup(item) {
    const cover = item.cover_url
      ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : "";
    return `
      <article class="video-card feed-video-card" data-feed-id="${escapeHtml(item.content_id)}">
        <div class="cover" role="img" aria-label="封面">
          ${cover}
          <span class="feed-badge">小红书</span>
        </div>
        <div>
          <p class="video-title">${escapeHtml(item.title || "无标题")}</p>
          <p class="video-meta">${escapeHtml(item.author || "")}${item.topic ? " · " + escapeHtml(item.topic) : ""}</p>
        </div>
        <p class="reason">${escapeHtml(item.summary_b || item.summary || "")}</p>
        <div class="card-actions">
          <button class="pill-btn small" type="button" data-feed-action="comments">看评论</button>
        </div>
      </article>`;
  }

  function addCommentsButton(card, contentId) {
    const actions = card.querySelector(".card-actions");
    if (!actions) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill-btn small";
    button.textContent = "看评论";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDetail(contentId);
    });
    actions.appendChild(button);
  }

  function render() {
    const grid = $("#videoGrid");
    if (!grid) return;
    grid.querySelectorAll("[data-feed-id]").forEach((node) => node.remove());
    if (!state.items.length) {
      // 没有主题内容时也必须给推荐卡片挂「看评论」：否则用户会看到功能凭空消失。
      enhanceRecommendationCards();
      return;
    }
    const build = typeof window.__obcBuildRecommendationCard === "function";
    for (const item of state.items) {
      const contentId = String(item.content_id || "");
      if (build) {
        const card = window.__obcBuildRecommendationCard(toRecommendationItem(item));
        card.dataset.feedId = contentId;
        addCommentsButton(card, contentId);
        grid.appendChild(card);
        continue;
      }
      const template = document.createElement("div");
      template.innerHTML = cardMarkup(item);
      const card = template.firstElementChild;
      if (!card) continue;
      card.querySelector('[data-feed-action="comments"]')?.addEventListener("click", (event) => {
        event.stopPropagation();
        openDetail(contentId);
      });
      card.addEventListener("click", (event) => {
        event.stopPropagation();
        openDetail(contentId);
      });
      grid.appendChild(card);
    }
    enhanceRecommendationCards();
  }

  // 推荐流里的小红书卡片也能「看评论」：复用同一套采集与详情弹层。
  function enhanceRecommendationCards() {
    document.querySelectorAll("#videoGrid .video-card:not([data-feed-id])").forEach((card) => {
      if (card.dataset.feedEnhanced === "1") return;
      const cover = card.querySelector("a.cover[href]");
      const platform = (card.querySelector(".platform")?.dataset.platform || "").toLowerCase();
      if (!cover || !platform.includes("xiaohongshu")) return;
      const actions = card.querySelector(".card-actions");
      if (!actions) return;
      card.dataset.feedEnhanced = "1";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pill-btn small";
      button.textContent = "看评论";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openByUrl(cover.href, card.querySelector(".video-title")?.textContent || "内容");
      });
      actions.appendChild(button);
    });
  }

  async function openByUrl(url, title) {
    const contentId = (String(url).match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/) || [])[1] || "";
    if (!contentId) {
      setStatus("这个链接里没有可用的笔记 ID");
      return;
    }
    state.openId = contentId;
    const overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.add("is-open");
    $("#feedDetailTitle").textContent = title || "内容";
    $("#feedDetailMeta").textContent = "小红书";
    $("#feedDetailSummary").textContent = "";
    $("#feedOpenLink").href = url;
    $("#feedComments").innerHTML = "";
    const button = $("#feedCollectBtn");
    button.disabled = true;
    $("#feedDetailStatus").textContent = "开始采评论（受限即停）…";
    button.onclick = () => collectCommentsByUrl(url, contentId);
    try {
      const job = await api("/comments", { method: "POST", body: JSON.stringify({ url }) });
      trackJob(job?.id, contentId);
    } catch (error) {
      $("#feedDetailStatus").textContent = `启动失败：${error.message}`;
      button.disabled = false;
    }
  }

  async function collectCommentsByUrl(url, contentId) {
    const job = await api("/comments", { method: "POST", body: JSON.stringify({ url }) });
    trackJob(job?.id, contentId);
  }

  async function loadFeed() {
    try {
      const data = await api("");
      state.items = data.items || [];
      render();
      if (typeof window.__obcFeedRender === "function" && $("#videoGrid")) render();
    } catch (error) {
      setStatus(`读取内容失败：${error.message}`);
    }
  }

  // 进行中的主题任务要跨刷新保留：以前只把状态放在内存里，刷新后既看不到进度，
  // 也看不到失败原因，用户只能看到一句"正在找"然后永远没有下文。
  const PENDING_KEY = "obc.feed.discover";
  const RESULT_KEY = "obc.feed.lastResult";
  const POLL_INTERVAL = 5000;
  const POLL_MAX_ROUNDS = 120; // 10 分钟；超过就交给后台，不再假装还在找。

  function rememberResult(text) {
    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify({ text, topic: state.topic || "", at: Date.now() }));
    } catch (_) {}
  }

  function restoreResult() {
    try {
      const data = JSON.parse(localStorage.getItem(RESULT_KEY) || "null");
      if (!data?.text) return;
      if (Date.now() - Number(data.at || 0) > 24 * 3600 * 1000) return;
      // 主题一并恢复：登录接通后可以直接自动重试，不用用户再输一遍。
      if (data.topic) state.topic = data.topic;
      setStatus(data.text, { login: needsLogin(data.text) });
    } catch (_) {}
  }

  // 终态结论既写页面也写本地：刷新后不该看到一片空白。
  // 超时或插件没连上时，系统自己打开工作区窗口，不要求用户去找入口。
  function systemShouldOpenBrowser(text) {
    return /插件未|限定时间内|工作区小红书|插件已更新|浏览器开着/.test(String(text || ""));
  }

  function finish(text) {
    const open = systemShouldOpenBrowser(text);
    setStatus(open ? `${text} 系统正在打开工作区小红书窗口。` : text, { login: needsLogin(text) });
    rememberResult(text);
    if (open && typeof window.__obcOpenXhsLogin === "function") window.__obcOpenXhsLogin();
  }

  function rememberJob(job, topic) {
    try {
      const id = String(job?.id || "");
      if (!id) return;
      localStorage.setItem(PENDING_KEY, JSON.stringify({ id, topic, at: Date.now() }));
    } catch (_) {}
  }

  function forgetJob() {
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }

  async function fetchJob(jobId) {
    const response = await fetch(`/api/research/jobs/${encodeURIComponent(jobId)}`, {
      headers: { "X-Research-Request": "1" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function startDiscover(topic) {
    if (state.busy) return;
    state.busy = true;
    state.topic = topic;
    setStatus(`正在找「${topic}」相关内容…（后台串行，约 1–3 分钟）`);
    try {
      const job = await api("/discover", { method: "POST", body: JSON.stringify({ topic, max_notes: 20 }) });
      state.jobId = job?.id || null;
      rememberJob(job, topic);
      pollJob(state.jobId, 0);
    } catch (error) {
      finish(`启动失败：${error.message}`);
      state.busy = false;
    }
  }

  function jobStateLabel(job) {
    return STATE_LABEL[job?.state] || job?.state || "未知状态";
  }

  // 轮询任务本身，而不是只轮询"有没有内容"：任务失败时立刻说清楚原因。
  function pollJob(jobId, round) {
    if (!jobId) { state.busy = false; return; }
    state.pollTimer = window.setTimeout(async () => {
      let job = null;
      let jobError = "";
      try {
        job = await fetchJob(jobId);
      } catch (error) {
        jobError = error.message;
      }
      await loadFeed();
      if (job && TERMINAL.has(job.state)) {
        state.busy = false;
        forgetJob();
        state.jobId = null;
        const suffix = job.message ? `：${job.message}` : "";
        if (job.state === "completed" || job.state === "partial") {
          finish(state.items.length
            ? `已补充 ${state.items.length} 条（任务${jobStateLabel(job)}${suffix}）。`
            : `任务${jobStateLabel(job)}，但没有内容入库${suffix}。`);
        } else {
          finish(`找「${state.topic || ""}」${jobStateLabel(job)}${suffix}。没有内容入库。系统正在打开工作区窗口，登录接通后会自动再找一次。`);
        }
        return;
      }
      if (job) {
        // 任务进行中要有可刷新的进度，否则前端一直显示开始时那一句，像卡死。
        const collected = Number(job?.counts?.contents || 0);
        const started = job.created_at ? new Date(job.created_at).getTime() : Date.now();
        const minutes = Math.max(0, Math.round((Date.now() - started) / 60000));
        setStatus(`正在找「${state.topic || ""}」…任务${jobStateLabel(job)}：已入库 ${collected} 篇 · 已跑 ${minutes} 分钟${job.message ? `；${job.message}` : ""}`);
      } else if (jobError) {
        setStatus(`读取任务状态失败：${jobError}（继续等待）`);
      }
      if (round >= POLL_MAX_ROUNDS) {
        state.busy = false;
        forgetJob();
        finish("超过 10 分钟仍未完成；任务可能还在后台跑，稍后刷新即可看到结果。");
        return;
      }
      pollJob(jobId, round + 1);
    }, POLL_INTERVAL);
  }

  // 页面刷新后恢复上次未结束的主题任务：进度和失败原因都不应该丢。
  async function resumePending() {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    } catch (_) {}
    if (!pending?.id) {
      restoreResult();
      return;
    }
    state.topic = pending.topic || state.topic;
    let job = null;
    try {
      job = await fetchJob(pending.id);
    } catch (_) {
      return; // 服务暂时不可达：保留记录，下次刷新再试。
    }
    if (!job) { forgetJob(); restoreResult(); return; }
    if (TERMINAL.has(job.state)) {
      forgetJob();
      if (job.state === "completed" || job.state === "partial") {
        await loadFeed();
        if (state.items.length) finish(`上次「${state.topic}」已补充 ${state.items.length} 条。`);
      } else {
        finish(`上次找「${state.topic}」${jobStateLabel(job)}${job.message ? `：${job.message}` : ""}。没有内容入库。系统正在打开工作区窗口，登录接通后会自动再找一次。`);
      }
      return;
    }
    state.busy = true;
    state.jobId = job.id;
    setStatus(`「${state.topic}」仍在后台找…任务${jobStateLabel(job)}${job.message ? `：${job.message}` : ""}`);
    pollJob(job.id, 0);
  }

  function ensureOverlay() {
    let overlay = $("#feedOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "feedOverlay";
    overlay.className = "overlay feed-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="scrim" data-feed-close="1"></div>
      <div class="modal-panel feed-detail" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><p class="eyebrow">Content</p><h3 id="feedDetailTitle"></h3></div>
          <button type="button" class="icon-btn" data-feed-close="1" aria-label="关闭">×</button>
        </div>
        <p id="feedDetailMeta" class="video-meta"></p>
        <p id="feedDetailSummary" class="feed-detail-summary"></p>
        <div class="drawer-actions">
          <button type="button" class="pill-btn primary" id="feedCollectBtn">采评论（二次确认）</button>
          <button type="button" class="pill-btn" id="feedDeleteBtn">删除这条</button>
          <a class="pill-btn" id="feedOpenLink" target="_blank" rel="noopener">打开原文</a>
        </div>
        <p id="feedDetailStatus" class="video-meta" aria-live="polite"></p>
        <div id="feedJobLog" class="feed-job-log" aria-live="polite"></div>
        <div id="feedComments" class="feed-comments"></div>
      </div>`;
    overlay.addEventListener("click", (event) => {
      if (event.target.dataset.feedClose) closeDetail();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  async function openDetail(contentId) {
    const item = state.items.find((it) => it.content_id === contentId);
    if (!item) return;
    state.openId = contentId;
    const overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.add("is-open");
    $("#feedDetailTitle").textContent = item.title || "无标题";
    $("#feedDetailMeta").textContent = [item.author, item.topic].filter(Boolean).join(" · ");
    $("#feedDetailSummary").textContent = item.summary_b || item.summary || "";
    $("#feedOpenLink").href = item.url || "#";
    $("#feedDetailStatus").textContent = "";
    $("#feedComments").innerHTML = "";
    $("#feedCollectBtn").onclick = () => collectComments(contentId);
    $("#feedDeleteBtn").onclick = () => deleteItem(contentId);
    await loadComments(contentId);
  }

  async function deleteItem(contentId) {
    if (!window.confirm("删除这条内容及其评论？不会影响画像推荐。")) return;
    try {
      const data = await api(`/items/${encodeURIComponent(contentId)}`, { method: "DELETE" });
      setStatus(`已删除（${data.removed || 0} 条记录）`);
      closeDetail();
      await loadFeed();
    } catch (error) {
      setStatus(`删除失败：${error.message}`);
    }
  }

  function closeDetail() {
    const overlay = $("#feedOverlay");
    if (overlay) {
      overlay.hidden = true;
      overlay.classList.remove("is-open");
    }
    state.openId = null;
  }

  function commentHtml(comment, isReply, parentNickname) {
    const name = comment.nickname || "匿名用户";
    const replyTo = isReply && parentNickname ? ` 回复 ${escapeHtml(parentNickname)}` : "";
    return `
      <div class="feed-comment${isReply ? " is-reply" : ""}">
        <p class="feed-comment-meta">${escapeHtml(name)}${replyTo}</p>
        <p>${escapeHtml(comment.text || comment.content || "")}</p>
      </div>`;
  }

  function renderCommentTree(items) {
    const byId = new Map(items.map((item) => [item.comment_id, item]));
    const repliesByRoot = new Map();
    for (const comment of items) {
      if (!comment.parent_comment_id) continue;
      const rootKey = comment.root_comment_id || comment.parent_comment_id;
      if (!repliesByRoot.has(rootKey)) repliesByRoot.set(rootKey, []);
      repliesByRoot.get(rootKey).push(comment);
    }
    const roots = items.filter((item) => !item.parent_comment_id);
    const html = [];
    for (const root of roots) {
      html.push(commentHtml(root, false));
      for (const reply of repliesByRoot.get(root.comment_id) || []) {
        html.push(commentHtml(reply, true, byId.get(reply.parent_comment_id)?.nickname || "楼主"));
      }
    }
    // 找不到根评论的回复也要显示，不能静默丢数据。
    const orphanRoots = [...repliesByRoot.keys()].filter((key) => !byId.has(key));
    for (const key of orphanRoots) {
      for (const reply of repliesByRoot.get(key)) {
        html.push(commentHtml(reply, true, "楼主"));
      }
    }
    return html.join("");
  }

  const STATE_LABEL = {
    queued: "排队中",
    running: "执行中",
    stopping: "正在停止",
    completed: "已完成",
    partial: "部分完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
  const jobTimers = new Map();

  function renderJobLog(lines) {
    const node = $("#feedJobLog");
    if (node) node.textContent = lines.join("\n");
  }

  async function trackJob(jobId, contentId) {
    if (!jobId) return;
    if (jobTimers.has(jobId)) return;
    const statusNode = $("#feedDetailStatus");
    const tick = async () => {
      try {
        const [job, events] = await Promise.all([
          fetch(`/api/research/jobs/${jobId}`).then((r) => r.json()),
          fetch(`/api/research/jobs/${jobId}/events`).then((r) => r.json()),
        ]);
        const state = job?.state || "queued";
        const lines = (events?.items || []).slice(0, 8).map((item) => {
          const time = item.time ? new Date(item.time).toLocaleTimeString() : "";
          return `${time}  ${item.message}`;
        });
        renderJobLog(lines);
        const suffix = job?.message ? ` · ${job.message}` : "";
        statusNode.textContent = `任务状态：${STATE_LABEL[state] || state}${suffix}`;
        if (TERMINAL.has(state)) {
          window.clearInterval(jobTimers.get(jobId));
          jobTimers.delete(jobId);
          await loadComments(contentId);
          await refreshSummary(contentId);
          await loadFeed();
        }
      } catch (error) {
        statusNode.textContent = `读取进度失败：${error.message}（稍后自动重试）`;
      }
    };
    jobTimers.set(jobId, window.setInterval(tick, 3000));
    tick();
  }

  async function loadComments(contentId) {
    try {
      const data = await api(`/comments/${encodeURIComponent(contentId)}`);
      const items = data.items || [];
      const box = $("#feedComments");
      if (!items.length) {
        box.innerHTML = `<p class="video-meta">还没有采集评论。点“采评论”才会请求平台。</p>`;
        return;
      }
      const roots = items.filter((item) => !item.parent_comment_id).length;
      const replies = items.length - roots;
      const meta = `已采 ${items.length} 条（一级 ${roots} / 回复 ${replies}）`;
      box.innerHTML = `<p class="video-meta">${escapeHtml(meta)}</p>` + renderCommentTree(items);
    } catch (error) {
      $("#feedComments").innerHTML = `<p class="video-meta">评论读取失败：${escapeHtml(error.message)}</p>`;
    }
  }

  async function collectComments(contentId) {
    const button = $("#feedCollectBtn");
    const statusNode = $("#feedDetailStatus");
    if (button.disabled) return;
    button.disabled = true;
    statusNode.textContent = "已在后台排队采评论（约 1–3 分钟，受限即停）…";
    try {
      const job = await api("/comments", { method: "POST", body: JSON.stringify({ content_id: contentId }) });
      trackJob(job?.id, contentId);
    } catch (error) {
      statusNode.textContent = `启动失败：${error.message}`;
      button.disabled = false;
    }
  }

  function pollComments(contentId, round) {
    if (round > 80) {
      $("#feedDetailStatus").textContent = "没有等到底；任务可能还在后台跑，稍后重新打开即可。";
      $("#feedCollectBtn").disabled = false;
      return;
    }
    window.setTimeout(async () => {
      const data = await api(`/comments/${encodeURIComponent(contentId)}`).catch(() => ({ items: [] }));
      if ((data.items || []).length) {
        $("#feedDetailStatus").textContent = "";
        $("#feedCollectBtn").disabled = false;
        await loadComments(contentId);
        await refreshSummary(contentId);
        await loadFeed();
      } else {
        pollComments(contentId, round + 1);
      }
    }, 6000);
  }

  async function refreshSummary(contentId) {
    const statusNode = $("#feedDetailStatus");
    statusNode.textContent = "正在生成摘要…";
    try {
      const data = await api("/summarize", {
        method: "POST",
        body: JSON.stringify({ content_id: contentId }),
      });
      $("#feedDetailSummary").textContent = data.b || data.a || "";
      statusNode.textContent = "";
    } catch (error) {
      statusNode.textContent = `摘要生成失败：${error.message}`;
    }
  }

  function init() {
    const form = $("#feedForm");
    if (!form) return;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const topic = ($("#feedTopic").value || "").trim();
      if (!topic) {
        setStatus("输入一个主题再找。");
        return;
      }
      startDiscover(topic);
    });
    $("#feedPurge")?.addEventListener("click", () => purgeFeed());
    window.__obcFeedRender = render;
    // 登录接通后自动把上一次没找成的主题重跑一遍，用户不用再点一次。
    window.addEventListener("obc:xhs-login-verified", () => {
      const topic = state.topic || "";
      if (!topic) { setStatus("小红书已连接，可以输入主题开始找。"); return; }
      if (state.busy) return;
      setStatus(`小红书已连接，重新找「${topic}」…`);
      startDiscover(topic);
    });
    void loadFeed().then(() => resumePending());
  }

  async function purgeFeed() {
    const topic = ($("#feedTopic").value || "").trim();
    const label = topic ? `主题「${topic}」的内容` : "全部主题内容";
    if (!window.confirm(`删除${label}（含评论）？不会影响画像推荐。`)) return;
    setStatus(`正在清空${label}…`);
    try {
      const data = await api("/purge", { method: "POST", body: JSON.stringify({ topic }) });
      setStatus(`已清空 ${data.count || 0} 条内容`);
      await loadFeed();
    } catch (error) {
      setStatus(`清空失败：${error.message}`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
