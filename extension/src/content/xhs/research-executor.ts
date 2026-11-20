/**
 * xhs research executor — content-script side of explicit research jobs.
 *
 * The backend never calls XHS itself. For each research step the background
 * opens a visible task tab on the note or search page; this module then only
 * scrolls the page and clicks "展开回复", exactly as a reader would, and
 * collects the responses of the requests the page sent by itself (captured by
 * the MAIN-world tap in ``xhs-token-sniffer.ts``). The page computes its own
 * signatures with the real browser fingerprint and login session.
 *
 * Pacing is owned here per action (``action_wait_ms`` between scrolls and
 * clicks) and by the backend between steps. ``max_requests`` bounds how many
 * page API responses one step may trigger. A login gate, a visible challenge
 * or a risk-control response code stops the step at once — no retry.
 */

import { detectXhsTaskLoginRequired, detectXhsTaskRiskControl } from "./risk-control.js";

const RESEARCH_SOURCE = "obc-xhs-research";
const RESEARCH_ARM_SOURCE = "obc-xhs-research-arm";
const RESEARCH_NOTE_REQUEST_SOURCE = "obc-xhs-research-note-request";

const FIRST_RESPONSE_WAIT_MS = 15_000;
const NEXT_RESPONSE_WAIT_MS = 10_000;
const NOTE_DETAIL_WAIT_MS = 10_000;
const MIN_ACTION_WAIT_MS = 1_500;
const MAX_ACTION_WAIT_MS = 120_000;
const MAX_IDLE_ROUNDS = 2;
// HTTP 461/471 and these API codes are XHS's verification / frequency walls.
const RISK_HTTP_STATUS = new Set([461, 471]);
const RISK_API_CODES = new Set([300011, 300012, 300013, 300015]);
const LOGIN_API_CODES = new Set([-100, -101, -104]);

export type XhsResearchTask =
  | {
      kind: "note";
      note_id: string;
      max_comments: number;
      include_replies: boolean;
      action_wait_ms: number;
      max_requests: number;
    }
  | {
      kind: "search";
      keyword: string;
      max_notes: number;
      action_wait_ms: number;
      max_requests: number;
    };

export interface XhsResearchResponse {
  endpoint: "search" | "comments" | "replies" | "feed";
  status: number;
  root_comment_id: string;
  payload: unknown;
}

export type XhsResearchStatus =
  | "ok"
  | "login_required"
  | "platform_restricted"
  | "request_cap_reached"
  | "unavailable"
  | "error";

export interface XhsResearchResult {
  request_id: string;
  status: XhsResearchStatus;
  reason?: string;
  note?: unknown;
  responses: XhsResearchResponse[];
  requests: number;
  reply_threads: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Classify a captured response; ``null`` means it is ordinary data. */
export function classifyResearchResponse(item: XhsResearchResponse): XhsResearchStatus | null {
  if (RISK_HTTP_STATUS.has(item.status)) return "platform_restricted";
  const payload = isRecord(item.payload) ? item.payload : {};
  const code = typeof payload.code === "number" ? payload.code : 0;
  if (LOGIN_API_CODES.has(code)) return "login_required";
  if (RISK_API_CODES.has(code)) return "platform_restricted";
  if (payload.success === false) return "error";
  return null;
}

function responseData(item: XhsResearchResponse): Record<string, unknown> {
  const payload = isRecord(item.payload) ? item.payload : {};
  return isRecord(payload.data) ? payload.data : {};
}

export function countTopLevelComments(responses: readonly XhsResearchResponse[]): number {
  const ids = new Set<string>();
  for (const item of responses) {
    if (item.endpoint !== "comments") continue;
    const comments = responseData(item).comments;
    if (!Array.isArray(comments)) continue;
    for (const comment of comments) {
      if (isRecord(comment) && typeof comment.id === "string") ids.add(comment.id);
    }
  }
  return ids.size;
}

export function countSearchNotes(responses: readonly XhsResearchResponse[]): number {
  const ids = new Set<string>();
  for (const item of responses) {
    if (item.endpoint !== "search") continue;
    const items = responseData(item).items;
    if (!Array.isArray(items)) continue;
    for (const entry of items) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      if (entry.model_type !== undefined && entry.model_type !== "note") continue;
      ids.add(entry.id);
    }
  }
  return ids.size;
}

/** ``has_more`` of the newest response for an endpoint; unknown counts as more. */
export function latestHasMore(
  responses: readonly XhsResearchResponse[],
  endpoint: XhsResearchResponse["endpoint"],
): boolean {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const item = responses[index];
    if (item?.endpoint !== endpoint) continue;
    return responseData(item).has_more !== false;
  }
  return true;
}

class ResponseCollector {
  readonly responses: XhsResearchResponse[] = [];
  private note: unknown = null;
  private noteRequestId = "";
  private waiters: Array<() => void> = [];
  private readonly listener = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as {
      source?: string;
      responses?: XhsResearchResponse[];
      request_id?: string;
      note?: unknown;
    } | null;
    if (data?.source !== RESEARCH_SOURCE) return;
    if (Array.isArray(data.responses) && data.responses.length > 0) {
      this.responses.push(...data.responses);
      const waiters = this.waiters.splice(0);
      for (const wake of waiters) wake();
    }
    if (data.request_id && data.request_id === this.noteRequestId && data.note) {
      this.note = data.note;
    }
  };

  arm(): void {
    window.addEventListener("message", this.listener);
    window.postMessage({ source: RESEARCH_ARM_SOURCE }, "*");
  }

  disarm(): void {
    window.removeEventListener("message", this.listener);
  }

  /** Resolve once a response arrives after ``since`` responses, or on timeout. */
  async waitForNew(since: number, timeoutMs: number): Promise<boolean> {
    if (this.responses.length > since) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      timer = setTimeout(resolve, timeoutMs);
    });
    if (timer) clearTimeout(timer);
    return this.responses.length > since;
  }

  async readNote(noteId: string): Promise<unknown> {
    const deadline = Date.now() + NOTE_DETAIL_WAIT_MS;
    while (Date.now() < deadline) {
      this.noteRequestId = `${noteId}-${Date.now()}`;
      window.postMessage(
        { source: RESEARCH_NOTE_REQUEST_SOURCE, note_id: noteId, request_id: this.noteRequestId },
        "*",
      );
      await sleep(500);
      if (this.note) return this.note;
    }
    return null;
  }

  /** The first stop condition among captured responses, if any. */
  stopStatus(): XhsResearchStatus | null {
    for (const item of this.responses) {
      const status = classifyResearchResponse(item);
      if (status && status !== "error") return status;
    }
    return null;
  }
}

function pageStopStatus(): XhsResearchStatus | null {
  if (detectXhsTaskLoginRequired(document)) return "login_required";
  if (detectXhsTaskRiskControl(document)) return "platform_restricted";
  return null;
}

function noteScroller(): HTMLElement {
  return (
    document.querySelector<HTMLElement>(".note-scroller") ??
    document.querySelector<HTMLElement>("#noteContainer .interaction-container") ??
    (document.scrollingElement as HTMLElement | null) ??
    document.documentElement
  );
}

function scrollToBottom(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
  element.dispatchEvent(new Event("scroll", { bubbles: true }));
  if (element === document.scrollingElement || element === document.documentElement) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    window.dispatchEvent(new Event("scroll"));
  }
}

const REPLY_EXPAND_PATTERN = /展开\s*\d*\s*条回复|展开更多回复/;

function nextReplyExpander(clicked: WeakSet<HTMLElement>): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    ".comments-container .show-more, .comments-container [class*='show-more']",
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index];
    if (!element || clicked.has(element)) continue;
    const text = element.textContent?.replace(/\s+/g, "") ?? "";
    if (REPLY_EXPAND_PATTERN.test(text)) return element;
  }
  return null;
}

function finish(
  requestId: string,
  collector: ResponseCollector,
  status: XhsResearchStatus,
  extra: Partial<XhsResearchResult> = {},
): XhsResearchResult {
  return {
    request_id: requestId,
    status,
    responses: collector.responses,
    requests: collector.responses.length,
    reply_threads: [],
    ...extra,
  };
}

async function runNoteTask(
  requestId: string,
  task: Extract<XhsResearchTask, { kind: "note" }>,
  collector: ResponseCollector,
  waitMs: number,
): Promise<XhsResearchResult> {
  const note = await collector.readNote(task.note_id);
  const blocked = pageStopStatus() ?? collector.stopStatus();
  if (blocked) return finish(requestId, collector, blocked, { note });
  if (!note) return finish(requestId, collector, "unavailable");

  const replyThreads: string[] = [];
  const done = (status: XhsResearchStatus): XhsResearchResult =>
    finish(requestId, collector, status, { note, reply_threads: replyThreads });

  // The page requests the first comment page on its own while loading.
  await collector.waitForNew(0, FIRST_RESPONSE_WAIT_MS);
  let idle = 0;
  while (
    countTopLevelComments(collector.responses) < task.max_comments &&
    latestHasMore(collector.responses, "comments") &&
    idle < MAX_IDLE_ROUNDS
  ) {
    const stop = pageStopStatus() ?? collector.stopStatus();
    if (stop) return done(stop);
    if (collector.responses.length >= task.max_requests) return done("request_cap_reached");
    await sleep(waitMs);
    const before = collector.responses.length;
    scrollToBottom(noteScroller());
    idle = (await collector.waitForNew(before, NEXT_RESPONSE_WAIT_MS)) ? 0 : idle + 1;
  }

  if (task.include_replies) {
    const clicked = new WeakSet<HTMLElement>();
    // At most one expansion per kept first-level comment; the page renders
    // whole comment pages, so later expanders may belong to unkept comments.
    for (let clicks = 0; clicks < task.max_comments; clicks += 1) {
      const stop = pageStopStatus() ?? collector.stopStatus();
      if (stop) return done(stop);
      const expander = nextReplyExpander(clicked);
      if (!expander) break;
      if (collector.responses.length >= task.max_requests) return done("request_cap_reached");
      await sleep(waitMs);
      clicked.add(expander);
      const before = collector.responses.length;
      expander.scrollIntoView({ block: "center" });
      expander.click();
      if (await collector.waitForNew(before, NEXT_RESPONSE_WAIT_MS)) {
        const latest = collector.responses[collector.responses.length - 1];
        if (latest?.endpoint === "replies" && latest.root_comment_id) {
          replyThreads.push(latest.root_comment_id);
        }
      }
    }
  }
  return done(pageStopStatus() ?? collector.stopStatus() ?? "ok");
}

async function runSearchTask(
  requestId: string,
  task: Extract<XhsResearchTask, { kind: "search" }>,
  collector: ResponseCollector,
  waitMs: number,
): Promise<XhsResearchResult> {
  await collector.waitForNew(0, FIRST_RESPONSE_WAIT_MS);
  let idle = 0;
  while (
    countSearchNotes(collector.responses) < task.max_notes &&
    latestHasMore(collector.responses, "search") &&
    idle < MAX_IDLE_ROUNDS
  ) {
    const stop = pageStopStatus() ?? collector.stopStatus();
    if (stop) return finish(requestId, collector, stop);
    if (collector.responses.length >= task.max_requests) {
      return finish(requestId, collector, "request_cap_reached");
    }
    await sleep(waitMs);
    const before = collector.responses.length;
    scrollToBottom((document.scrollingElement as HTMLElement | null) ?? document.documentElement);
    idle = (await collector.waitForNew(before, NEXT_RESPONSE_WAIT_MS)) ? 0 : idle + 1;
  }
  const stop = pageStopStatus() ?? collector.stopStatus();
  if (stop) return finish(requestId, collector, stop);
  return finish(requestId, collector, countSearchNotes(collector.responses) ? "ok" : "unavailable");
}

export async function executeResearchTask(
  requestId: string,
  task: XhsResearchTask,
): Promise<XhsResearchResult> {
  const collector = new ResponseCollector();
  collector.arm();
  const waitMs = Math.min(Math.max(task.action_wait_ms, MIN_ACTION_WAIT_MS), MAX_ACTION_WAIT_MS);
  try {
    return task.kind === "note"
      ? await runNoteTask(requestId, task, collector, waitMs)
      : await runSearchTask(requestId, task, collector, waitMs);
  } catch {
    return finish(requestId, collector, "error", { reason: "page_executor_failed" });
  } finally {
    collector.disarm();
  }
}

const startedRequests = new Set<string>();

export function registerResearchExecutor(): void {
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
    if (message.action !== "XHS_RESEARCH_EXECUTE") return false;
    const data = message.data as { request_id?: string; task?: XhsResearchTask } | undefined;
    if (!data?.request_id || !data.task) return false;
    // Ack at once so the background stops re-sending; a re-sent step never runs twice.
    sendResponse({ accepted: true });
    if (startedRequests.has(data.request_id)) return false;
    startedRequests.add(data.request_id);
    void executeResearchTask(data.request_id, data.task).then(async (result) => {
      try {
        await chrome.runtime.sendMessage({ action: "XHS_RESEARCH_RESULT", data: result });
      } catch {
        // The background times the step out and reports it; nothing to retry here.
      }
    });
    return false;
  });
}
