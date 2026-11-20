/**
 * MAIN-world script — observes xhs's own fetch/XHR responses to learn
 * ``(note_id, xsec_token)`` pairs and postMessages them to the isolated
 * content script. For the search endpoint it also emits the same minimal
 * public card metadata that the DOM collector reports, allowing hidden
 * discovery tabs to work even when XHS skips mounting its virtualized grid.
 *
 * Why MAIN world? Content scripts run in an isolated JS context, so
 * overriding ``window.fetch`` there doesn't intercept the page's own
 * fetches. MAIN-world scripts share state with the page, letting us
 * wrap the same ``fetch`` / ``XMLHttpRequest`` objects the xhs React
 * app uses.
 *
 * What we do NOT do: mutate requests, fingerprint the user, or expose raw
 * responses to ordinary browsing. Only token pairs and normalized public
 * search-card fields leave MAIN world, except that an explicitly armed
 * research task tab also receives the raw search / comment / reply / feed
 * responses its own page requested (see "Research task tap" below).
 *
 * The isolated content script listens via ``window.addEventListener
 * ("message", ...)`` and filters by ``source: "obc-xhs-sniffer"``.
 */

import {
  extractXhsSearchResponseNotes,
  isXhsSearchApiUrl,
  type XhsSearchResponseNote,
} from "../shared/xhs-search-response.ts";
import {
  extractPublishedTimesFromPayload,
  type XhsPublishedTime,
} from "../shared/xhs-published-at.ts";

interface TokenPair {
  note_id: string;
  xsec_token: string;
}

const POST_MESSAGE_SOURCE = "obc-xhs-sniffer";
const REPLAY_REQUEST_SOURCE = "obc-xhs-search-replay-request";
let latestSearchNotes: XhsSearchResponseNote[] = [];

const NOTE_ID_KEYS = ["note_id", "noteId", "id"] as const;
const TOKEN_KEYS = ["xsec_token", "xsecToken"] as const;

/**
 * Walk a JSON blob and harvest every plausible ``(note_id, xsec_token)``
 * pair. xhs's internal responses vary wildly in shape (feed API, search
 * API, user-profile API all nest differently) so we do a depth-first
 * scan rather than targeting specific paths that break on schema drift.
 *
 * Exported so the test file can exercise it without a browser.
 */
export function extractTokenPairs(payload: unknown): TokenPair[] {
  const out: TokenPair[] = [];
  const seen = new Set<string>();

  function pushIfNew(pair: TokenPair): void {
    if (!pair.note_id || !pair.xsec_token) return;
    const key = `${pair.note_id}|${pair.xsec_token}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(pair);
  }

  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const obj = node as Record<string, unknown>;
    let note_id = "";
    let xsec_token = "";
    for (const k of NOTE_ID_KEYS) {
      const v = obj[k];
      if (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v)) {
        note_id = v;
        break;
      }
    }
    for (const k of TOKEN_KEYS) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 0) {
        xsec_token = v;
        break;
      }
    }
    pushIfNew({ note_id, xsec_token });

    for (const value of Object.values(obj)) walk(value);
  }

  walk(payload);
  return out;
}

function emit(
  pairs: TokenPair[],
  searchNotes?: XhsSearchResponseNote[],
  publishedNotes?: XhsPublishedTime[],
): void {
  if (pairs.length === 0 && searchNotes === undefined && !publishedNotes?.length) return;
  window.postMessage(
    {
      source: POST_MESSAGE_SOURCE,
      pairs,
      search_notes: searchNotes,
      published_notes: publishedNotes,
    },
    "*",
  );
}

function isXhsApiUrl(url: string): boolean {
  // xhs serves its web APIs from edith.xiaohongshu.com and
  // /api/sns/web/ paths on the main origin. Match both.
  return url.includes("/api/sns/web/") || url.includes("edith.xiaohongshu.com");
}

async function parseResponseSafely(res: Response): Promise<unknown> {
  // Clone before reading — the page still needs the original body.
  try {
    const clone = res.clone();
    const text = await clone.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Research task tap ───────────────────────────────────────────────
//
// Research jobs read XHS data only through requests the page itself sends
// (the page computes its own signature with the real browser fingerprint).
// Responses of the four research endpoints are kept in a small ring buffer,
// because the first comment page loads before the isolated content script
// can arm the tap. Nothing leaves MAIN world until a research executor in
// the same tab arms it; ordinary browsing tabs never forward raw payloads.
const RESEARCH_SOURCE = "obc-xhs-research";
const RESEARCH_ARM_SOURCE = "obc-xhs-research-arm";
const RESEARCH_NOTE_REQUEST_SOURCE = "obc-xhs-research-note-request";
const RESEARCH_BUFFER_MAX = 40;

export type XhsResearchEndpoint = "search" | "comments" | "replies" | "feed";

export interface XhsResearchResponse {
  endpoint: XhsResearchEndpoint;
  status: number;
  root_comment_id: string;
  payload: unknown;
}

export function classifyXhsResearchUrl(rawUrl: string): XhsResearchEndpoint | null {
  let path = "";
  try {
    path = new URL(rawUrl, "https://www.xiaohongshu.com/").pathname;
  } catch {
    return null;
  }
  if (path.endsWith("/api/sns/web/v1/search/notes")) return "search";
  if (path.endsWith("/api/sns/web/v2/comment/sub/page")) return "replies";
  if (path.endsWith("/api/sns/web/v2/comment/page")) return "comments";
  if (path.endsWith("/api/sns/web/v1/feed")) return "feed";
  return null;
}

const researchBuffer: XhsResearchResponse[] = [];
let researchArmed = false;

function recordResearchResponse(url: string, status: number, payload: unknown): void {
  const endpoint = classifyXhsResearchUrl(url);
  if (!endpoint) return;
  let rootCommentId = "";
  try {
    rootCommentId = new URL(url, "https://www.xiaohongshu.com/").searchParams.get("root_comment_id") ?? "";
  } catch {
    rootCommentId = "";
  }
  const item: XhsResearchResponse = { endpoint, status, root_comment_id: rootCommentId, payload };
  if (researchArmed) {
    window.postMessage({ source: RESEARCH_SOURCE, responses: [item] }, "*");
    return;
  }
  researchBuffer.push(item);
  if (researchBuffer.length > RESEARCH_BUFFER_MAX) researchBuffer.shift();
}

/** Copy plain data out of Vue reactive state; drops refs' dep graphs and cycles. */
function plainClone(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (depth > 12 || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.__v_isRef) return plainClone(record._value ?? record.value, seen, depth + 1);
  if (Array.isArray(value)) return value.map((child) => plainClone(child, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key.startsWith("__v") || key === "dep") continue;
    const child = plainClone(record[key], seen, depth + 1);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

/** The note page's server-rendered state already holds the full note detail. */
function readResearchNoteDetail(noteId: string): unknown {
  const state = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
  const noteState = plainClone(state?.note, new WeakSet(), 0) as Record<string, unknown> | undefined;
  const detailMap = noteState?.noteDetailMap as Record<string, { note?: unknown }> | undefined;
  return detailMap?.[noteId]?.note ?? null;
}

function installResearchBridge(): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; note_id?: unknown; request_id?: unknown } | null;
    if (data?.source === RESEARCH_ARM_SOURCE) {
      researchArmed = true;
      const buffered = researchBuffer.splice(0);
      window.postMessage({ source: RESEARCH_SOURCE, responses: buffered }, "*");
      return;
    }
    if (data?.source === RESEARCH_NOTE_REQUEST_SOURCE && typeof data.note_id === "string") {
      let note: unknown = null;
      try {
        note = readResearchNoteDetail(data.note_id);
      } catch {
        note = null;
      }
      window.postMessage({ source: RESEARCH_SOURCE, request_id: data.request_id, note }, "*");
    }
  });
}

function handleApiPayload(url: string, payload: unknown, status = 200): void {
  recordResearchResponse(url, status, payload);
  const pairs = extractTokenPairs(payload);
  const publishedNotes = extractPublishedTimesFromPayload(payload);
  if (isXhsSearchApiUrl(url)) {
    latestSearchNotes = extractXhsSearchResponseNotes(payload);
    emit(pairs, latestSearchNotes, publishedNotes);
    return;
  }
  emit(pairs, undefined, publishedNotes);
}

type TaggedXhr = XMLHttpRequest & { __obcXhsUrl?: string };

/**
 * Wrap window.fetch and XMLHttpRequest so every xhs API response is
 * scanned for ``(note_id, xsec_token)`` pairs. Called once at module
 * load time in MAIN-world context; factored out so unit tests can
 * import ``extractTokenPairs`` without triggering browser-only code.
 */
function installSniffer(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function wrappedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch(input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url && isXhsApiUrl(url)) {
        void parseResponseSafely(response).then((json) => {
          if (json !== null) handleApiPayload(url, json, response.status);
        });
      }
    } catch {
      // swallow — never break the page's fetch
    }
    return response;
  };

  const XhrProto = XMLHttpRequest.prototype;
  const originalOpen = XhrProto.open;
  const originalSend = XhrProto.send;

  XhrProto.open = function patchedOpen(
    this: TaggedXhr,
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ): void {
    this.__obcXhsUrl = typeof url === "string" ? url : url.href;
    return originalOpen.call(
      this,
      method,
      url,
      async ?? true,
      user ?? null,
      password ?? null,
    );
  };

  XhrProto.send = function patchedSend(
    this: TaggedXhr,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const url = this.__obcXhsUrl ?? "";
    if (url && isXhsApiUrl(url)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            const text = this.responseText;
            if (text) {
              const json = JSON.parse(text);
              handleApiPayload(url, json, this.status);
            }
          } else if (this.responseType === "json") {
            handleApiPayload(url, this.response, this.status);
          }
        } catch {
          // swallow
        }
      });
    }
    return originalSend.call(this, body ?? null);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string } | null;
    if (data?.source !== REPLAY_REQUEST_SOURCE) return;
    emit([], latestSearchNotes);
  });
  installResearchBridge();

  console.debug("[OpenBiliClaw] xhs token sniffer installed (MAIN world)");
}

// Only auto-install when loaded in a browser context (MAIN world content
// script). Guard on ``typeof window`` so node test runners that import
// this module for ``extractTokenPairs`` don't crash at load time.
if (typeof window !== "undefined" && typeof XMLHttpRequest !== "undefined") {
  installSniffer();
}
