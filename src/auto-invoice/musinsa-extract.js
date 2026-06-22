// 목적: 무신사 마이페이지에서 송장 추출 — 원본 확장 checkMusinsaTracking 로직 포팅 (background.js:2373-2571).
// 서버 직접조회 불가(React SPA + deliveryInfo API 거부) → 브라우저 탭에서 DOM 추출만 가능.

const MUSINSA_ORDER_URL = 'https://www.musinsa.com/order/order-detail/';
const COURIER_WHITELIST = ['CJ대한통운', 'CJ 대한통운', '롯데', '한진', '우체국', '로젠', '경동', '합동'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve(false);
        if (tab.status === 'complete') return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 300);
      });
    };
    check();
  });
}

// content world 함수 (executeScript 주입) — Step1 배송조회 버튼 클릭
function clickDeliveryButton() {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryClick = () => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').trim().includes('배송 조회')) { btn.click(); return resolve({ clicked: true }); }
      }
      for (const a of document.querySelectorAll('a')) {
        if ((a.textContent || '').trim().includes('배송 조회')) { a.click(); return resolve({ clicked: true }); }
      }
      if (Date.now() - start > 5000) {
        let shippingStatus = '';
        const stateDiv = document.querySelector('[class*="GoodsItemState"]');
        if (stateDiv) shippingStatus = stateDiv.textContent.trim().replace(/\s+/g, ' ');
        const btnTexts = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 20)).filter(Boolean).slice(0, 12);
        return resolve({ clicked: false, reason: '배송 조회 버튼 없음 (미발송)', shippingStatus, debug: btnTexts });
      }
      setTimeout(tryClick, 500);
    };
    tryClick();
  });
}

// content world 함수 — Step3 송장 추출 (3단 폴백)
function extractTracking(couriers) {
  return new Promise((resolve) => {
    const start = Date.now();
    const norm = (s) => (s || '').replace(/[ ​﻿]/g, ' ').trim();
    const tryExtract = () => {
      // 1) .company-name + .tracking-number
      const c = document.querySelector('.company-name');
      const t = document.querySelector('.tracking-number');
      if (c && t) {
        const company = norm(c.textContent);
        const num = norm(t.textContent).replace(/[^0-9]/g, '');
        if (company && num) return resolve({ found: true, company, trackingNumber: num });
      }
      // 2) delivery-detail-tracking innerText 라벨 파싱
      const box = document.querySelector('[class*="delivery-detail-tracking"]');
      if (box) {
        const lines = norm(box.innerText).split('\n').map((s) => s.trim()).filter(Boolean);
        let company = '', num = '';
        for (let i = 0; i < lines.length; i++) {
          if (/택배사|배송사/.test(lines[i]) && lines[i + 1]) company = lines[i + 1];
          if (/송장|운송장/.test(lines[i]) && lines[i + 1]) num = lines[i + 1].replace(/[^0-9]/g, '');
        }
        if (company && num) return resolve({ found: true, company, trackingNumber: num });
      }
      // 3) body 전체 — 택배사 화이트리스트 + 10~15자리 숫자
      if (Date.now() - start > 10000) {
        const body = norm(document.body.innerText);
        let company = '';
        for (const cw of couriers) { if (body.includes(cw)) { company = cw; break; } }
        const m = body.match(/\b(\d{10,15})\b/);
        if (company && m) return resolve({ found: true, company, trackingNumber: m[1] });
        return resolve({ found: false, reason: '송장 추출 실패 (타임아웃)', debug: {
          companyNameEl: !!document.querySelector('.company-name'),
          trackingNumberEl: !!document.querySelector('.tracking-number'),
          trackingBox: !!document.querySelector('[class*="delivery-detail-tracking"]'),
          bodyCourier: company || '(없음)',
          bodyNumber: m ? m[1] : '(없음)',
          bodyHead: body.slice(0, 120),
        } });
      }
      setTimeout(tryExtract, 500);
    };
    tryExtract();
  });
}

/**
 * 무신사 주문번호로 송장 추출.
 * @returns {{found:boolean, company?:string, trackingNumber?:string, reason?:string, shippingStatus?:string}}
 */
export async function extractMusinsaTracking(orderNumber, tabId) {
  try {
    await chrome.tabs.update(tabId, { url: MUSINSA_ORDER_URL + encodeURIComponent(orderNumber) });
    const loaded = await waitForTabLoad(tabId, 15000);
    if (!loaded) return { found: false, reason: '무신사 페이지 로드 실패' };
    // 백그라운드 탭은 React 렌더/네트워크가 지연될 수 있어 추출 동안 포그라운드로 활성화 (검수 HIGH).
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
    await sleep(2000); // React SPA 렌더

    const clickRes = await chrome.scripting.executeScript({ target: { tabId }, func: clickDeliveryButton }).catch(() => null);
    if (!clickRes || !clickRes[0]) return { found: false, reason: `배송조회 스크립트 실패: ${chrome.runtime.lastError?.message || '탭 무효'}` };
    const click = clickRes[0].result;
    // 로그인 만료 감지
    const cur = await chrome.tabs.get(tabId);
    if (/login|signin/i.test(cur.url || '')) return { found: false, reason: '무신사 로그인 필요' };
    if (!click?.clicked) {
      return { found: false, reason: click?.reason || '배송조회 버튼 클릭 실패', shippingStatus: click?.shippingStatus || '', debug: click?.debug };
    }
    await sleep(3000); // 배송추적 뷰 로드

    const exRes = await chrome.scripting.executeScript({ target: { tabId }, func: extractTracking, args: [COURIER_WHITELIST] });
    return exRes?.[0]?.result || { found: false, reason: '추출 스크립트 실패' };
  } catch (e) {
    return { found: false, reason: e?.message || '추출 예외' };
  }
}

// 무신사 택배사명 → Lonit 표준 택배사 (bulk-inline 저장값)
const COURIER_MAP = [
  [/cj|대한통운/i, 'CJ대한통운'],
  [/롯데/i, '롯데택배'],
  [/한진/i, '한진택배'],
  [/우체국|epost/i, '우체국택배'],
  [/로젠/i, '로젠택배'],
  [/경동/i, '경동택배'],
];
export function normalizeCourier(name) {
  const s = (name || '').trim();
  for (const [re, std] of COURIER_MAP) if (re.test(s)) return std;
  return s; // 미매칭은 원본 유지 (bulk-inline 가 extra option 보존)
}
