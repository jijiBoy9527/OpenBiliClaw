/**
 * 首页推荐流里的「主题补充」能力。
 *
 * 与「为你推荐的内容」是同一个流，不是第二个板块：
 * - 默认按画像推荐（由 app.js 渲染）；
 * - 顶部输入主题 → MediaCrawler 只找这类内容 → 卡片接在推荐卡后面；
 * - 每张卡都能「看评论」，评论必须二次确认才采。
 */
(() => {
  const BASE = "/api/feed";
  const state = { items: [], busy: false, pollTimer: null, openId: null };

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

  function setStatus(text) {
    const node = $("#feedStatus");
    if (node) node.textContent = text || "";
  }

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

  function render() {
    const grid = $("#videoGrid");
    if (!grid) return;
    grid.querySelectorAll(".feed-video-card").forEach((node) => node.remove());
    if (!state.items.length) return;
    const template = document.createElement("div");
    template.innerHTML = state.items.map(cardMarkup).join("");
    const cards = [...template.children];
    cards.forEach((card) => {
      card.querySelector('[data-feed-action="comments"]')?.addEventListener("click", (event) => {
        event.stopPropagation();
        openDetail(card.dataset.feedId);
      });
      card.addEventListener("click", (event) => {
        event.stopPropagation();
        openDetail(card.dataset.feedId);
      });
      grid.appendChild(card);
    });
    enhanceRecommendationCards();
  }

  // 推荐流里的小红书卡片也能「看评论」：复用同一套采集与详情弹层。
  function enhanceRecommendationCards() {
    document.querySelectorAll("#videoGrid .video-card:not(.feed-video-card)").forEach((card) => {
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

  async function startDiscover(topic) {
    if (state.busy) return;
    state.busy = true;
    setStatus(`正在找「${topic}」相关内容…（后台串行，约 1–3 分钟）`);
    try {
      await api("/discover", { method: "POST", body: JSON.stringify({ topic, max_notes: 20 }) });
      pollUntilContent(0);
    } catch (error) {
      setStatus(`启动失败：${error.message}`);
      state.busy = false;
    }
  }

  function pollUntilContent(round) {
    if (round > 60) {
      state.busy = false;
      setStatus("没有等到底；任务可能还在后台跑，稍后刷新即可。");
      return;
    }
    state.pollTimer = window.setTimeout(async () => {
      await loadFeed();
      if (state.items.length) {
        state.busy = false;
        setStatus(`已补充 ${state.items.length} 条。`);
      } else {
        pollUntilContent(round + 1);
      }
    }, 5000);
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
    loadFeed();
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
