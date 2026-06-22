/**
 * 목적: 더망고-style invisible window collector — Chrome MV3 background service worker 에서
 *      사용. chrome.windows.create({state:'minimized', focused:false}) 로 사용자에게 거의
 *      보이지 않는 창을 만들고, chrome.scripting.executeScript 로 사이트별 ready-signal
 *      폴링 + outerHTML 캡처 runner 를 주입한다. 결과를 background 가 받으면 창 close.
 *
 * background.js 에서 사용:
 *   import { collectFromUrl } from './window-collector.js';
 *   const result = await collectFromUrl(searchUrl, 'worksout', { timeoutMs: 30000 });
 *   if (result.status === 'ok') {
 *     const products = await SITE_PARSERS.worksout.parse(result.html, searchUrl, result.extraHtml);
 *   }
 *
 * runner 와 contract:
 *   - runner.js 가 window.__LONIT_SITE_NAME__ 에서 siteName 읽음
 *   - SITES[siteName].ready() 를 1초 간격 polling
 *   - ready 가 true 면 document.documentElement.outerHTML 캡처
 *   - chrome.runtime.sendMessage({ type: 'WINDOW_COLLECTOR_RESULT', payload: {...} }) 발사
 *
 * 결과 status enum:
 *   - 'ok'            — html 정상 캡처
 *   - 'timeout'       — runner 응답 없음 (30s 초과)
 *   - 'inject_failed' — executeScript 실패 (CSP/권한)
 *   - 'bot_block'     — runner 가 captcha/cf-challenge 감지 시 반환
 *   - 'no_parser'     — runner 가 siteName 모르는 경우
 *
 * 에러 처리:
 *   - 모든 종료 경로에서 try/finally 로 chrome.windows.remove (window 누수 방지)
 *   - signal.abort 시 reject — 호출자가 catch
 */

/**
 * @typedef {Object} WindowCollectorResult
 * @property {'ok'|'timeout'|'inject_failed'|'bot_block'|'no_parser'} status
 * @property {string} html         - document.documentElement.outerHTML (timeout/inject_failed 시 '')
 * @property {string|null} extraHtml - 추가 HTML (Gmarket iframe 등). 없으면 null.
 * @property {string} url          - runner 가 본 location.href (timeout 시 '')
 * @property {string} [siteName]   - 에코백 (디버깅)
 * @property {string} [error]      - inject_failed 시 에러 메시지
 */

// 2026-05-18 hotfix #8: lazy-registered message handler — SW lifecycle 안전 + test 호환.
// closure 안 listener 는 SW wake up 후 사라질 수 있음 (MV3 SW lifecycle).
// collectFromUrl 호출 시 1회 등록 (idempotent). SW wake up 후 첫 collectFromUrl 가 재등록.
const windowCollectorResolvers = new Map();
let topLevelListenerRegistered = false;

function ensureTopLevelListener() {
  if (topLevelListenerRegistered) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage?.addListener) return;
  topLevelListenerRegistered = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'WINDOW_COLLECTOR_RESULT') return false;
    const siteName = msg?.payload?.siteName;
    const senderWindowId = sender?.tab?.windowId;
    console.log('[windowCollector top-level] message received — siteName:', siteName, 'senderWindowId:', senderWindowId, 'status:', msg?.payload?.status, 'html.length:', msg?.payload?.html?.length);
    const resolver = windowCollectorResolvers.get(siteName);
    if (resolver) {
      windowCollectorResolvers.delete(siteName);
      resolver(msg.payload);
      if (typeof sendResponse === 'function') sendResponse({ received: true });
    } else {
      console.warn('[windowCollector top-level] no resolver for siteName:', siteName, 'pending:', Array.from(windowCollectorResolvers.keys()));
      if (typeof sendResponse === 'function') sendResponse({ received: false, reason: 'no resolver' });
    }
    return false;
  });
  console.log('[windowCollector] top-level listener registered');
}

/** TEST ONLY — module-level state reset. production 에서 호출 금지. */
export function _resetForTest() {
  topLevelListenerRegistered = false;
  windowCollectorResolvers.clear();
}

/**
 * minimized window 로 url 을 열고, siteName 에 맞는 runner 로 outerHTML 을 수집해 반환.
 *
 * @param {string} url
 * @param {string} siteName
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<WindowCollectorResult>}
 */
export async function collectFromUrl(url, siteName, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signal = opts.signal;
  const collectLimit = opts.collectLimit;

  ensureTopLevelListener();

  // 2026-05-18 hotfix: state='minimized' 는 width/height/top/left 와 동시 사용 불가
  //   ("Invalid value for state").
  // 2026-05-19 사용자 신고 "수집 창 보이는 게 방해" 응답 — 2-step 전략:
  //   1) state='normal' + type='popup' (tab/menu bar 없는 가벼운 chrome) + off-screen
  //      position (-32000) + focused:false 로 생성. 가능한 OS/Chrome 조합에서는 화면
  //      밖이라 시각적으로 안 보임.
  //   2) Chrome 가 음수 좌표 클램프해서 visible (left >= -1000) 이면 immediately
  //      state='minimized' 로 전환 — taskbar 만 등장.
  //   3) (1) 자체 실패 catch 시 그냥 minimize 로 fallback (구 동작).
  const taggedUrl = appendSiteQuery(url, siteName, collectLimit);
  let win;
  try {
    win = await chrome.windows.create({
      url: taggedUrl,
      type: 'popup',
      state: 'normal',
      focused: false,
      left: -32000,
      top: -32000,
      width: 1280,
      height: 800,
    });
    // Chrome 가 좌표 클램프했으면 (visible) → minimize 로 hide
    if (win && typeof win.left === 'number' && win.left > -1000) {
      try {
        await chrome.windows.update(win.id, { state: 'minimized', focused: false });
      } catch (e) {
        console.warn('[windowCollector] off-screen→minimize fallback 실패:', e?.message);
      }
    }
  } catch (e) {
    console.warn('[windowCollector] off-screen create 실패, minimize fallback:', e?.message);
    win = await chrome.windows.create({
      url: taggedUrl,
      type: 'popup',
      state: 'minimized',
      focused: false,
    });
  }
  const windowId = win.id;
  const tabId = win.tabs?.[0]?.id;
  console.log('[windowCollector] window created — windowId:', windowId, 'tabId:', tabId, 'siteName:', siteName, 'url:', taggedUrl, 'left:', win?.left, 'state:', win?.state);

  // 2026-05-18 hotfix #9: minimized tab 이 chrome 의 메모리 절약 모드로 discard 되는 의심 회피.
  // autoDiscardable:false → chrome 의 자동 discard 차단.
  if (tabId && chrome.tabs?.update) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (e) {
      console.warn('[windowCollector] tabs.update autoDiscardable 실패:', e?.message);
    }
  }

  try {
    return await waitForResult(windowId, siteName, timeoutMs, signal);
  } finally {
    try {
      await chrome.windows.remove(windowId);
      console.log('[windowCollector] window removed:', windowId);
    } catch (e) {
      console.log('[windowCollector] window remove 실패 (이미 close 됐을 수 있음):', e?.message);
    }
  }
}

/**
 * runner 의 WINDOW_COLLECTOR_RESULT 메시지 또는 timeout 까지 대기.
 *
 * @param {number} tabId
 * @param {string} siteName
 * @param {number} timeoutMs
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<WindowCollectorResult>}
 */
function waitForResult(windowId, siteName, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      windowCollectorResolvers.delete(siteName);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      console.log('[windowCollector] timeout fired — windowId:', windowId, 'siteName:', siteName);
      cleanup();
      resolve({ status: 'timeout', html: '', extraHtml: null, url: '', siteName });
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };

    // siteName 으로 Map 에 resolver 등록 — top-level listener 가 매칭해서 호출.
    windowCollectorResolvers.set(siteName, (payload) => {
      clearTimeout(timer);
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(payload);
    });

    if (signal) signal.addEventListener('abort', onAbort);
    // manifest content_scripts 가 페이지 로드 시 runner.js 자동 inject — background 의 scripting 호출 불필요.
  });
}

/** searchUrl 에 ?__lonit_site=siteName + (선택) __lonit_limit=N query 추가. */
function appendSiteQuery(rawUrl, siteName, limit) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('__lonit_site', siteName);
    if (typeof limit === 'number' && limit > 0) {
      u.searchParams.set('__lonit_limit', String(limit));
    }
    return u.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    const limitPart = (typeof limit === 'number' && limit > 0) ? `&__lonit_limit=${limit}` : '';
    return `${rawUrl}${sep}__lonit_site=${encodeURIComponent(siteName)}${limitPart}`;
  }
}
