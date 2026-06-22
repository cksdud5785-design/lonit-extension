// 목적: chrome.tabs + chrome.scripting 공용 유틸리티 (SSG/롯데온 수집기 공유)

const TAB_LOAD_TIMEOUT = 20000; // 20초
const NAV_TIMEOUT = 15000;      // 15초
const RENDER_WAIT = 3000;       // JS 렌더링 대기 3초

/** 탭 생성 + 로딩 완료 대기 + JS 렌더링 대기 */
export function openTab(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`탭 로드 타임아웃: ${url}`)), TAB_LOAD_TIMEOUT);
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          // JS 렌더링 대기 (Next.js/React hydration)
          setTimeout(() => resolve(tab), RENDER_WAIT);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

/** 탭 URL 변경 + 로딩 완료 대기 + JS 렌더링 대기 */
export function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`탭 탐색 타임아웃: ${url}`)), NAV_TIMEOUT);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => resolve(), RENDER_WAIT);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

/** 탭 닫기 (에러 무시) */
export function closeTab(tabId) {
  try {
    return chrome.tabs.remove(tabId).catch(() => {});
  } catch { return Promise.resolve(); }
}

/** executeScript 래퍼 — 재시도 포함 (렌더링 지연 대응) */
export async function injectScript(tabId, func, args = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args: [args],
      });
      const result = results?.[0]?.result;
      
      // 검색 결과인 경우: items가 빈 배열이면 렌더링 미완 → 재시도
      if (result && typeof result === 'object' && 'items' in result) {
        if (result.items.length === 0 && attempt < retries) {
          console.log(`[tab-utils] 결과 0개, ${attempt + 1}/${retries + 1} 재시도 (2초 대기)...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }
      
      return result;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`[tab-utils] executeScript 실패 (${attempt + 1}/${retries + 1}):`, err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
