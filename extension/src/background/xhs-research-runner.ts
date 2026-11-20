/**
 * xhs research runner — background side of explicit research jobs.
 *
 * The local research backend publishes ``xhs_research_task_requested`` on the
 * runtime stream for every step (one search page, or one note's comments).
 * This runner opens a visible, muted task tab on that page, lets the content
 * script drive it like a reader (``research-executor.ts``), and POSTs the
 * page's own captured responses to ``/api/research/task-result``.
 *
 * Boundaries:
 * - loopback backends only: a remotely configured backend never receives
 *   research payloads from the user's logged-in browser;
 * - one step at a time, sharing the cross-dispatcher mutex with the other
 *   task tabs so automatic discovery never races a research tab;
 * - no cookies leave the browser, and nothing is retried here — the backend
 *   decides whether a job continues after a failed or restricted step.
 *
 * The tab is foreground on purpose: XHS only loads more comments from
 * scroll / intersection events, which Chrome pauses for hidden tabs.
 */

const _MUTEX_STALE_MS = 6 * 60 * 1000;
function tryAcquireDispatcherMutex(label: string): boolean {
  const g = globalThis as unknown as {
    __OBC_DISPATCHER_MUTEX_HOLDER__?: string;
    __OBC_DISPATCHER_MUTEX_HELD_SINCE__?: number;
  };
  if (g.__OBC_DISPATCHER_MUTEX_HOLDER__) {
    if (Date.now() - (g.__OBC_DISPATCHER_MUTEX_HELD_SINCE__ ?? 0) > _MUTEX_STALE_MS) {
      g.__OBC_DISPATCHER_MUTEX_HOLDER__ = undefined;
    } else {
      return false;
    }
  }
  g.__OBC_DISPATCHER_MUTEX_HOLDER__ = label;
  g.__OBC_DISPATCHER_MUTEX_HELD_SINCE__ = Date.now();
  return true;
}
function refreshDispatcherMutex(label: string): void {
  const g = globalThis as unknown as {
    __OBC_DISPATCHER_MUTEX_HOLDER__?: string;
    __OBC_DISPATCHER_MUTEX_HELD_SINCE__?: number;
  };
  // Research steps can outlive the 6 min stale window; keep the claim fresh.
  if (g.__OBC_DISPATCHER_MUTEX_HOLDER__ === label) g.__OBC_DISPATCHER_MUTEX_HELD_SINCE__ = Date.now();
}
function releaseDispatcherMutex(label: string): void {
  const g = globalThis as unknown as {
    __OBC_DISPATCHER_MUTEX_HOLDER__?: string;
    __OBC_DISPATCHER_MUTEX_HELD_SINCE__?: number;
  };
  if (g.__OBC_DISPATCHER_MUTEX_HOLDER__ === label) {
    g.__OBC_DISPATCHER_MUTEX_HOLDER__ = undefined;
    g.__OBC_DISPATCHER_MUTEX_HELD_SINCE__ = undefined;
  }
}

import { apiUrl } from "../shared/backend-endpoint.ts";
import { authenticatedFetch } from "../shared/auth.ts";
import { withTaskTabMarker } from "../shared/task-tab.ts";
import { createTaskTab } from "./task-tab.ts";

const MUTEX_LABEL = "xhs-research";
const XHS_TASK_MARKER = "openbiliclaw_xhs_task";
const MUTEX_WAIT_MS = 90_000;
const TAB_LOAD_TIMEOUT_MS = 30_000;
const EXECUTOR_HANDSHAKE_ATTEMPTS = 10;
const STEP_BASE_TIMEOUT_MS = 90_000;
const STEP_PER_REQUEST_MS = 15_000;
const STEP_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const NOTE_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

interface NoteStep {
  kind: "note";
  url: string;
  note_id: string;
  max_comments: number;
  include_replies: boolean;
  action_wait_ms: number;
  max_requests: number;
}

interface SearchStep {
  kind: "search";
  keyword: string;
  max_notes: number;
  action_wait_ms: number;
  max_requests: number;
}

export type XhsResearchStep = NoteStep | SearchStep;

interface StepResult {
  request_id: string;
  status: string;
  reason?: string;
  [key: string]: unknown;
}

let stepInFlight = false;
const resultWaiters = new Map<string, { tabId: number; resolve: (result: StepResult) => void }>();

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Validate a backend step; anything malformed is dropped, never "repaired" into a URL. */
export function parseResearchStep(raw: unknown): XhsResearchStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const step = raw as Record<string, unknown>;
  const actionWait = boundedInt(step.action_wait_ms, 0, 120_000);
  const maxRequests = boundedInt(step.max_requests, 1, 500);
  if (actionWait === null || maxRequests === null) return null;
  if (step.kind === "note") {
    const noteId = typeof step.note_id === "string" ? step.note_id : "";
    const maxComments = boundedInt(step.max_comments, 1, 500);
    if (!NOTE_ID_PATTERN.test(noteId) || maxComments === null || typeof step.url !== "string") return null;
    let url: URL;
    try {
      url = new URL(step.url);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname)) {
      return null;
    }
    if (!url.pathname.includes(noteId) || !url.searchParams.get("xsec_token")) return null;
    return {
      kind: "note", url: url.href, note_id: noteId, max_comments: maxComments,
      include_replies: step.include_replies === true, action_wait_ms: actionWait, max_requests: maxRequests,
    };
  }
  if (step.kind === "search") {
    const keyword = typeof step.keyword === "string" ? step.keyword.trim() : "";
    const maxNotes = boundedInt(step.max_notes, 1, 200);
    if (!keyword || keyword.length > 100 || maxNotes === null) return null;
    return { kind: "search", keyword, max_notes: maxNotes, action_wait_ms: actionWait, max_requests: maxRequests };
  }
  return null;
}

export function researchStepUrl(step: XhsResearchStep): string {
  const url = step.kind === "note"
    ? step.url
    : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(step.keyword)}&source=web_search_result_notes`;
  return withTaskTabMarker(url, XHS_TASK_MARKER);
}

export function researchStepTimeoutMs(step: XhsResearchStep): number {
  const perAction = STEP_PER_REQUEST_MS + step.action_wait_ms;
  return Math.min(STEP_BASE_TIMEOUT_MS + step.max_requests * perAction, STEP_MAX_TIMEOUT_MS);
}

async function loopbackEndpoint(path: string): Promise<URL | null> {
  const endpoint = new URL(await apiUrl(path));
  return ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ? endpoint : null;
}

async function postStepResult(result: StepResult): Promise<void> {
  const endpoint = await loopbackEndpoint("/research/task-result");
  if (!endpoint) return;
  try {
    await authenticatedFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    console.warn("[openbiliclaw] could not deliver the XHS research step result");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId: number): Promise<boolean> {
  const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && tab.url && tab.url !== "about:blank") return true;
    } catch {
      return false;
    }
    await sleep(500);
  }
  return false;
}

async function acquireMutex(): Promise<boolean> {
  const deadline = Date.now() + MUTEX_WAIT_MS;
  while (!tryAcquireDispatcherMutex(MUTEX_LABEL)) {
    if (Date.now() > deadline) return false;
    await sleep(2_000);
  }
  return true;
}

async function runStep(requestId: string, step: XhsResearchStep): Promise<StepResult> {
  if (!(await acquireMutex())) {
    return { request_id: requestId, status: "error", reason: "browser_busy" };
  }
  let tabId: number | undefined;
  // An extension API call resets the MV3 worker idle timer; timers alone do not,
  // and a step can wait minutes for the task tab.
  const keepAlive = setInterval(() => {
    refreshDispatcherMutex(MUTEX_LABEL);
    void chrome.runtime.getPlatformInfo();
  }, 20_000);
  try {
    const tab = await createTaskTab({ url: researchStepUrl(step), active: true });
    tabId = tab.id;
    if (tabId === undefined || !(await waitForTabComplete(tabId))) {
      return { request_id: requestId, status: "error", reason: "tab_load_timeout" };
    }
    const resultPromise = new Promise<StepResult>((resolve) => {
      resultWaiters.set(requestId, { tabId: tabId as number, resolve });
    });
    // The content script only needs the step parameters; the tab already has the URL.
    const task: Record<string, unknown> = { ...step };
    delete task.url;
    let delivered = false;
    for (let attempt = 0; attempt < EXECUTOR_HANDSHAKE_ATTEMPTS && !delivered; attempt += 1) {
      try {
        const ack = (await chrome.tabs.sendMessage(tabId, {
          action: "XHS_RESEARCH_EXECUTE",
          data: { request_id: requestId, task },
        })) as { accepted?: boolean } | undefined;
        delivered = ack?.accepted === true;
        if (!delivered) await sleep(1_000);
      } catch {
        // The document_idle content script may not be listening yet.
        await sleep(1_000);
      }
    }
    if (!delivered) return { request_id: requestId, status: "error", reason: "executor_unreachable" };
    const timeout = new Promise<StepResult>((resolve) => {
      setTimeout(
        () => resolve({ request_id: requestId, status: "error", reason: "step_timeout" }),
        researchStepTimeoutMs(step),
      );
    });
    return await Promise.race([resultPromise, timeout]);
  } catch {
    return { request_id: requestId, status: "error", reason: "tab_failed" };
  } finally {
    clearInterval(keepAlive);
    resultWaiters.delete(requestId);
    if (tabId !== undefined) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The user may already have closed the research tab.
      }
    }
    releaseDispatcherMutex(MUTEX_LABEL);
  }
}

async function handleStep(requestId: string, step: XhsResearchStep): Promise<void> {
  if (stepInFlight) {
    await postStepResult({ request_id: requestId, status: "error", reason: "browser_busy" });
    return;
  }
  if (!(await loopbackEndpoint("/research/task-result"))) return;
  stepInFlight = true;
  try {
    await postStepResult(await runStep(requestId, step));
  } finally {
    stepInFlight = false;
  }
}

/** Runtime-stream entry; returns true when the event belonged to research. */
export function handleXhsResearchRuntimeEvent(event: Record<string, unknown>): boolean {
  if (event.type === "xhs_research_task_cancelled") {
    // The job was stopped in the workbench: end the step so its tab closes.
    const waiter = resultWaiters.get(String(event.request_id ?? ""));
    waiter?.resolve({ request_id: String(event.request_id), status: "cancelled" });
    return true;
  }
  if (event.type !== "xhs_research_task_requested") return false;
  const requestId = String(event.request_id ?? "");
  if (!REQUEST_ID_PATTERN.test(requestId)) return true;
  const step = parseResearchStep(event.step);
  if (!step) {
    void postStepResult({ request_id: requestId, status: "error", reason: "invalid_step" });
    return true;
  }
  void handleStep(requestId, step);
  return true;
}

/** Route ``XHS_RESEARCH_RESULT`` from the task tab that owns the step. */
export function registerXhsResearchRunner(): void {
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender) => {
    if (message.action !== "XHS_RESEARCH_RESULT") return false;
    const result = message.data as StepResult | undefined;
    const waiter = result?.request_id ? resultWaiters.get(result.request_id) : undefined;
    if (waiter && sender.tab?.id === waiter.tabId) waiter.resolve(result as StepResult);
    return false;
  });
}
