// 목적: 웹(lonit.kr)→확장 "주문시작"(소싱처 체크아웃 자동입력) 외부 메시지 핸들러.
// Phase 1a 스켈레톤: origin 검증 → API 로 정본 payload 재조회 → 보이는 탭 open 까지만.
// Phase 1b 에서 이 탭에 무신사 체크아웃 자동입력 핸들러를 주입할 예정(현재는 폴백=탭만 open).
// spec: docs/superpowers/specs/2026-07-01-sourcing-order-autofill-design.md (§9)
import { apiCall } from './api.js';
import { cdpSelectOptionAndBuy } from './cdp-driver.js';
import { cdpLotteonOptionAndBuy } from './lotteon-checkout.js';

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
          // 무신사: CDP 자동화(옵션 STRICT 매칭→선택→수량→구매하기→주문서→고객주소 생성→결제 직전 정지).
          // 옵션 문자열은 원문 그대로 전달(드라이버가 옵션 API 와 토큰 대조, 옵션 없는 상품도 처리).
          // ★응답은 탭 오픈 직후 즉시 ack — 전체 플로우(30~60s)를 기다리면 웹 sendMessage 가
          //   타임아웃돼 "확장 실행 실패"로 오판. 진행/결과는 열린 탭에서 사용자가 보고,
          //   최종 결과는 lastCdpResult(storage, GET_LAST_RESULT)로 남긴다.
          // 배송 정보: 서버 payload(주문자 정보)가 기본. 팝업 "직접 입력" 시 msg.recipient 로 커스텀 값이
          //   오며 값 있는 필드만 덮어쓴다(0504 안심번호 → 사용자가 실번호 입력 등). 벤더 무관 공통.
          const ov = msg.recipient || {};
          const pick = (a, b) => (a != null && String(a).trim() !== '' ? a : b);
          const rc = d.recipient || {};
          const recipient = {
            name: pick(ov.name, rc.name),
            phone: pick(ov.phone, rc.phone),
            zipcode: pick(ov.zipCode ?? ov.zipcode, rc.zipCode),
            address: pick(ov.address, rc.address),
            addressDetail: pick(ov.addressDetail, rc.addressDetail),
          };
          const runCdp = async (fn) => {
            const tab = await chrome.tabs.create({ url: sourceUrl, active: true });
            try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { void e; }
            try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { void e; }
            sendResponse({ ok: true, phase: 'cdp', accepted: true });
            try { await waitTabComplete(tab.id); const r = await fn(tab.id); await chrome.storage.local.set({ lastCdpResult: { at: Date.now(), orderId, res: r } }); }
            catch (err) { try { await chrome.storage.local.set({ lastCdpResult: { at: Date.now(), orderId, res: { ok: false, error: err && err.message ? err.message : 'cdp failed' } } }); } catch (e2) { void e2; } }
          };
          if (d.vendor === 'musinsa' && goodsNo && d.recipient) {
            await runCdp((tabId) => cdpSelectOptionAndBuy(tabId, goodsNo, d.option || '', { recipient, quantity: d.quantity }));
            return;
          }
          if (d.vendor === 'lotteon' && d.recipient) {
            await runCdp((tabId) => cdpLotteonOptionAndBuy(tabId, sourceUrl, d.option || '', { recipient }));
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
      const option = String(msg.option || msg.targetSize || '').trim().slice(0, 200);
      if (!goodsNo) {
        sendResponse({ ok: false, error: 'goodsNo required' });
        return;
      }
      (async () => {
        let res = null;
        try {
          const tab = await chrome.tabs.create({ url: `https://www.musinsa.com/products/${goodsNo}`, active: true });
          // 탭 창을 포커스+활성화(렌더 강제 — 백그라운드 탭은 innerHeight=0 이라 옵션 클릭 불가).
          try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { void e; }
          try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { void e; }
          await waitTabComplete(tab.id);
          res = await cdpSelectOptionAndBuy(tab.id, goodsNo, option, { recipient: msg.recipient, quantity: msg.quantity });
        } catch (err) {
          res = { ok: false, error: err && err.message ? err.message : 'cdp test failed' };
        }
        // 응답 채널 유실 대비: 결과를 storage 에도 남김(GET_LAST_RESULT 로 조회).
        try { await chrome.storage.local.set({ lastCdpResult: { at: Date.now(), goodsNo, res } }); } catch (e) { void e; }
        try { sendResponse(res); } catch (e) { void e; }
      })();
      return true; // 비동기 sendResponse 유지
    }

    // dev 테스트: 롯데온 옵션선택→바로구매→주문서→배송지(결제 직전 정지). url/option/recipient 직접 지정.
    if (msg && msg.type === 'LOTTEON_TEST') {
      const url = String(msg.url || '');
      const option = String(msg.option || '').trim().slice(0, 200);
      const recipient = msg.recipient || null;
      if (!url) { sendResponse({ ok: false, error: 'url required' }); return; }
      const closeTab = msg.keepTab ? false : true;
      (async () => {
        let res = null; let tabId = null;
        try {
          // 이전 테스트로 누적된 롯데온 주문서 탭 정리(리소스/CDP 충돌 방지).
          try { const olds = await chrome.tabs.query({ url: 'https://www.lotteon.com/p/order/*' }); for (const t of olds) { try { await chrome.tabs.remove(t.id); } catch (e) { void e; } } } catch (e) { void e; }
          const tab = await chrome.tabs.create({ url, active: true }); tabId = tab.id;
          try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { void e; }
          try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { void e; }
          await waitTabComplete(tab.id);
          res = await cdpLotteonOptionAndBuy(tab.id, url, option, { recipient });
        } catch (err) { res = { ok: false, error: err && err.message ? err.message : 'lotteon test failed' }; }
        try { await chrome.storage.local.set({ lastCdpResult: { at: Date.now(), res } }); } catch (e) { void e; }
        if (closeTab && tabId != null) { try { await chrome.tabs.remove(tabId); } catch (e) { void e; } }
        try { sendResponse(res); } catch (e) { void e; }
      })();
      return true;
    }

    // dev: 마지막 CDP 테스트 결과 조회(응답 채널 유실 시 폴백).
    if (msg && msg.type === 'GET_LAST_RESULT') {
      chrome.storage.local.get(['lastCdpResult'], (o) => { sendResponse(o && o.lastCdpResult ? o.lastCdpResult : null); });
      return true;
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
