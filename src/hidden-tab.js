/**
 * 목적: 사용자에게 보이지 않는 작업 탭 생성 — popup window + off-screen position +
 *      minimized fallback. 기존 `chrome.tabs.create({ active: false })` 패턴의
 *      drop-in 대체.
 *
 * 배경 (2026-05-26):
 *   - 무신사 / SSG / 롯데온 수집기가 CSR 페이지 hydration 결과를 얻기 위해 새 탭을 띄움
 *   - `active: false` 여도 사용자에게 새 탭이 명확히 보이는 문제 발생 (사용자 신고)
 *   - 더망고 확장 패턴 카피 후 가시성 더 증가
 *
 * 해결 전략 (PR #1049 의 window-collector.js 패턴 재사용):
 *   1. `chrome.windows.create({ type:'popup', state:'normal', focused:false,
 *      left:-32000, top:-32000 })` — 화면 밖 popup window 생성
 *   2. Chrome 가 음수 좌표 클램프해서 visible 이면 `state:'minimized'` 로 전환
 *   3. (1) 자체 실패 catch 시 `state:'minimized'` fallback (구 동작)
 *
 * 효과:
 *   - 탭 바에 새 탭 표시 안 됨 (popup window 라 메인 윈도우 영향 없음)
 *   - 일부 OS 에서 taskbar minimize 아이콘 만 잠깐 보일 수 있음
 *   - 100% invisible 은 Chrome MV3 의 한계로 불가능 (offscreen API 는 외부 도메인
 *     iframe X-Frame-Options 차단 — CSR 페이지 hydration 불가)
 *
 * Drop-in 대체 사용 예:
 *   기존:  const tab = await chrome.tabs.create({ url, active: false });
 *   변경:  const tab = await createHiddenTab(url);  // 반환 객체 호환 (id, windowId 포함)
 */

const TAB_LOAD_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} HiddenTab
 * @property {number} id        - chrome.tabs.Tab.id — 호출자 호환
 * @property {number} windowId  - popup window id (cleanup 시 사용)
 */

/**
 * 사용자에게 보이지 않는 popup window 를 만들고 그 안의 단일 탭을 반환.
 * `chrome.tabs.create({ url, active: false })` 의 drop-in 대체.
 *
 * @param {string} url
 * @returns {Promise<HiddenTab>}
 */
export async function createHiddenTab(url) {
  let win;
  try {
    win = await chrome.windows.create({
      url,
      type: 'popup',
      state: 'normal',
      focused: false,
      left: -32000,
      top: -32000,
      width: 1280,
      height: 800,
    });
    // Chrome 좌표 클램프해서 visible 이면 minimize 로 hide
    if (win && typeof win.left === 'number' && win.left > -1000) {
      try {
        await chrome.windows.update(win.id, { state: 'minimized', focused: false });
      } catch (e) {
        console.warn('[hiddenTab] off-screen→minimize fallback 실패:', e?.message);
      }
    }
  } catch (e) {
    console.warn('[hiddenTab] off-screen create 실패, minimize fallback:', e?.message);
    win = await chrome.windows.create({
      url,
      type: 'popup',
      state: 'minimized',
      focused: false,
    });
  }

  const tab = win?.tabs?.[0];
  if (!tab?.id) {
    throw new Error('[hiddenTab] popup window 에 탭이 없음 (Chrome 버그?)');
  }

  // chrome 의 자동 메모리 절약 discard 방지 (window-collector.js 와 동일 안전장치)
  if (chrome.tabs?.update) {
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) {
      console.warn('[hiddenTab] autoDiscardable 설정 실패:', e?.message);
    }
  }

  return { id: tab.id, windowId: win.id };
}

/**
 * 기존 hidden tab 의 url 변경 (window/tab 재사용). 사이트별 _xxxTabId 패턴과 호환.
 * `chrome.tabs.update(tabId, { url, active: false })` 의 drop-in 대체.
 *
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function navigateHiddenTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
}

/**
 * hidden tab 닫기 (popup window 도 마지막 탭 닫히면 함께 close).
 * 에러 silent — 이미 닫혔을 수 있음.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function closeHiddenTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 이미 닫혔거나 권한 없음 — silent
  }
}

/**
 * hidden tab url 로드 + complete 대기 + 렌더링 대기.
 * 기존 tab-utils.openTab 의 hidden 버전.
 *
 * @param {string} url
 * @param {{ renderWaitMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<HiddenTab>}
 */
export function openHiddenTabAndWait(url, opts = {}) {
  const renderWaitMs = opts.renderWaitMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? TAB_LOAD_TIMEOUT_MS;

  return new Promise(async (resolve, reject) => {
    let tab;
    try {
      tab = await createHiddenTab(url);
    } catch (e) {
      return reject(e);
    }

    const tabId = tab.id;
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`hidden tab 로드 타임아웃: ${url}`));
    }, timeoutMs);

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => resolve(tab), renderWaitMs);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
