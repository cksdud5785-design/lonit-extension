// 목적: 웹(lonit.kr)→확장 "주문시작"(소싱처 체크아웃 자동입력) 외부 메시지 핸들러.
// Phase 1a 스켈레톤: origin 검증 → API 로 정본 payload 재조회 → 보이는 탭 open 까지만.
// Phase 1b 에서 이 탭에 무신사 체크아웃 자동입력 핸들러를 주입할 예정(현재는 폴백=탭만 open).
// spec: docs/superpowers/specs/2026-07-01-sourcing-order-autofill-design.md (§9)
import { apiCall } from './api.js';
import { cdpSelectOptionAndBuy } from './cdp-driver.js';

// externally_connectable 로 허용된 정확한 오리진만 신뢰(least privilege).
const ALLOWED_ORIGIN = 'https://www.lonit.kr';

// 탭이 로드 완료('complete')될 때까지 대기(타임아웃 시에도 resolve).
function waitTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { void e; }
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => { if (!chrome.runtime.lastError && t && t.status === 'complete') finish(); });
    setTimeout(finish, timeout);
  });
}

// payload.option 에서 사이즈 토큰 추출. 앞뒤 영숫자 경계 확인 → "ADIDAS"의 S, "M-65"의 M,
// 색상명 오탐 방지. "아디다스…White, M x1"→M, "블랙/M"→M, "M"→M. 없으면 원본 trim.
function extractSizeToken(opt) {
  const m = String(opt || '').toUpperCase().match(/(?<![A-Z0-9])(4XL|3XL|2XL|XL|XS|S|M|L)(?![A-Z0-9])/);
  return m ? m[1] : String(opt || '').trim();
}

export function registerSourcingExternalHandler() {
  if (!chrome.runtime.onMessageExternal) return; // 구버전 방어
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    // 보안: 웹페이지 sender 는 sender.origin 만 신뢰(sender.id/url 비신뢰).
    if (sender.origin !== ALLOWED_ORIGIN) {
      sendResponse({ ok: false, error: 'forbidden origin' });
      return; // 동기 응답
    }

    if (msg && msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }

    if (msg && msg.type === 'START_SOURCING_CHECKOUT') {
      const orderId = Number(msg.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        sendResponse({ ok: false, error: 'invalid orderId' });
        return;
      }
      // 메시지엔 {orderId, vendor} 만 옴(PII 없음) — 정본(수령인/주소/전화/옵션)은 서버에서 재조회.
      (async () => {
        try {
          const res = await apiCall(`/sourcing/orders/${orderId}/payload`);
          const d = res && res.data;
          const sourceUrl = d ? d.sourceUrl : null;
          if (!sourceUrl) {
            sendResponse({ ok: false, error: 'no source url' });
            return;
          }
          const goodsNo = (String(sourceUrl).match(/products\/(\d+)/) || [])[1];
          // 무신사: CDP 자동화(옵션선택→구매하기→주문서→고객주소 생성/기본지정→결제 직전 정지).
          if (d.vendor === 'musinsa' && goodsNo && d.option && d.recipient) {
            const rc = d.recipient;
            const recipient = { name: rc.name, phone: rc.phone, zipcode: rc.zipCode, address: rc.address, addressDetail: rc.addressDetail };
            const tab = await chrome.tabs.create({ url: sourceUrl, active: true });
            try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { void e; }
            try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { void e; }
            await waitTabComplete(tab.id);
            const r = await cdpSelectOptionAndBuy(tab.id, extractSizeToken(d.option), { recipient });
            sendResponse(r && r.ok ? { ok: true, phase: 'cdp', stage: r.stage } : { ok: false, phase: 'cdp', error: (r && r.stage) || 'cdp failed', detail: r });
            return;
          }
          // 폴백: 미지원 벤더/조건 미충족 → 보이는 탭 open(사용자 수동 진행/결제).
          await chrome.tabs.create({ url: sourceUrl, active: true });
          sendResponse({ ok: true, phase: '1a-open-tab' });
        } catch (err) {
          sendResponse({ ok: false, error: err && err.message ? err.message : 'checkout failed' });
        }
      })();
      return true; // 비동기 sendResponse 유지
    }

    // CDP 자동입력 격리 검증용(dev): Lonit payload 없이 goodsNo+size 로 옵션선택→구매하기→주문서까지 구동.
    // 결제는 절대 하지 않음(주문서 도달 후 정지). 검증 통과 후 START_SOURCING_CHECKOUT 에 통합 예정.
    if (msg && msg.type === 'CDP_CHECKOUT_TEST') {
      const goodsNo = String(msg.goodsNo || '').replace(/[^0-9]/g, '');
      const targetSize = String(msg.targetSize || '').trim().slice(0, 20);
      if (!goodsNo || !targetSize) {
        sendResponse({ ok: false, error: 'goodsNo/targetSize required' });
        return;
      }
      (async () => {
        try {
          const tab = await chrome.tabs.create({ url: `https://www.musinsa.com/products/${goodsNo}`, active: true });
          // 탭 창을 포커스+활성화(렌더 강제 — 백그라운드 탭은 innerHeight=0 이라 옵션 클릭 불가).
          try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { void e; }
          try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { void e; }
          await waitTabComplete(tab.id);
          const res = await cdpSelectOptionAndBuy(tab.id, targetSize, { recipient: msg.recipient });
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: err && err.message ? err.message : 'cdp test failed' });
        }
      })();
      return true; // 비동기 sendResponse 유지
    }

    // 자가 리로드(dev 자동화): 코드 수정 후 확장을 프로그램적으로 재로드(unpacked 는 디스크서 재읽음).
    if (msg && msg.type === 'RELOAD_SELF') {
      sendResponse({ ok: true, reloading: true });
      setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { void e; } }, 150);
      return true;
    }

    return false; // 미처리 메시지
  });
}
