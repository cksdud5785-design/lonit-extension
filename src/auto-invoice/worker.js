// 목적: 자동송장 오케스트레이터 (서비스워커). 원본 확장의 더망고 조종을 Lonit API 호출로 대체.
// 흐름: alarm/RUN_NOW → Lonit 송장대기 큐 조회 → 무신사 탭서 송장 추출 → 저장(bulk-inline) + 마켓전송(send-tracking).
// 상태 전이/합배송/재시도는 서버 책임 (확장은 추출+API 호출만).

import { fetchMusinsaPendingOrders, saveTracking, sendTrackingToMarket, fetchAutoInvoiceSettings } from './lonit-api.js';
import { extractMusinsaTracking, normalizeCourier } from './musinsa-extract.js';

const ALARM = 'lonit-auto-invoice';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let isRunning = false;

async function log(line, red) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push({ t: Date.now(), line, red: !!red });
  await chrome.storage.local.set({ logs: logs.slice(-200) });
  console.log(`[자동송장]${red ? '⚠' : ''} ${line}`);
}

// 무신사 작업용 단일 탭 확보 (anti-bot: 직렬 처리)
async function ensureWorkTab() {
  // storage.local 사용 (session 은 SW 재시작 시 유실 → 탭 누적). 탭 소실 감지 시 정리 후 재생성.
  const { workTabId } = await chrome.storage.local.get('workTabId');
  if (workTabId) {
    try { await chrome.tabs.get(workTabId); return workTabId; }
    catch { await chrome.storage.local.remove('workTabId'); }
  }
  const tab = await chrome.tabs.create({ url: 'https://www.musinsa.com/order', active: false });
  await chrome.storage.local.set({ workTabId: tab.id });
  return tab.id;
}

async function runCycle(trigger) {
  if (isRunning) { await log('이미 실행 중 — skip'); return; }
  isRunning = true;
  try {
    const settings = await fetchAutoInvoiceSettings().catch(() => null);
    if (trigger === 'alarm' && !settings?.enabled) return; // 자동은 enabled 일 때만
    await log(`자동송장 사이클 시작 (${trigger})`);

    const queue = await fetchMusinsaPendingOrders();
    await log(`송장대기 ${queue.length}건`);
    if (queue.length === 0) return;

    const tabId = await ensureWorkTab();
    let ok = 0, miss = 0, fail = 0;
    for (let i = 0; i < queue.length; i++) {
      const o = queue[i];
      if (!o.sourceOrderNo) { miss++; continue; }
      const ex = await extractMusinsaTracking(o.sourceOrderNo, tabId);
      if (!ex.found) {
        miss++;
        const dbg = ex.debug ? ` | 진단: ${JSON.stringify(ex.debug)}` : (ex.shippingStatus ? ` | 상태: ${ex.shippingStatus}` : '');
        await log(`......[${i + 1}] ${o.sourceOrderNo} — ${ex.reason || '송장 없음'}${dbg}`);
        if (/로그인 필요/.test(ex.reason || '')) { await log('무신사 로그인 만료 — 중단', true); break; }
      } else {
        try {
          const courier = normalizeCourier(ex.company);
          await saveTracking(o.orderId, courier, ex.trackingNumber);
          const sres = await sendTrackingToMarket(o.orderId);
          const r = (sres?.data?.results || [])[0];
          if (r && r.success === false) { fail++; await log(`......[${i + 1}] ${o.sourceOrderNo} 전송실패: ${r.error || '?'}`, true); }
          else { ok++; await log(`......[${i + 1}] ${o.sourceOrderNo} → ${courier} ${ex.trackingNumber} 전송완료`); }
        } catch (e) {
          fail++; await log(`......[${i + 1}] ${o.sourceOrderNo} 오류: ${e?.message}`, true);
        }
      }
      if (i < queue.length - 1) await sleep(3000); // anti-bot 직렬 딜레이
    }
    await log(`사이클 완료 — 전송 ${ok} / 미발송 ${miss} / 실패 ${fail}`);
  } catch (e) {
    await log(`사이클 예외: ${e?.message}`, true);
  } finally {
    isRunning = false;
  }
}

// 알람 주기 동기화 (설정의 intervalMinutes)
async function syncAlarm() {
  const s = await fetchAutoInvoiceSettings().catch(() => null);
  await chrome.alarms.clear(ALARM);
  if (s?.enabled) {
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, s.intervalMinutes || 10) });
  }
}

// 확장 재로드/설치 시 이미 열려있는 lonit.kr 탭에 브릿지를 프로그래매틱 주입.
// (content script 는 새 페이지 로드에만 주입되므로 — 사용자 F5 없이도 연결되게)
async function injectBridgeToOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.lonit.kr/*' });
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/auto-invoice/lonit-bridge.js'] });
        await log(`브릿지 주입: 탭 ${t.id}`);
      } catch (e) { /* 이미 주입됨/권한 등 — 무시 */ }
    }
  } catch (e) { /* tabs 권한 등 */ }
}

chrome.runtime.onStartup.addListener(() => { isRunning = false; void syncAlarm(); void injectBridgeToOpenTabs(); });
chrome.runtime.onInstalled.addListener(() => { void syncAlarm(); void injectBridgeToOpenTabs(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void runCycle('alarm'); });

// v2 페이지(lonit-bridge)·popup 메시지 수신
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'LONIT_AUTO_INVOICE_PING') { sendResponse({ pong: true }); return; }
  if (msg?.type === 'LONIT_AUTO_INVOICE_RUN_NOW') { void runCycle('manual'); sendResponse({ started: true }); return; }
  if (msg?.type === 'LONIT_AUTO_INVOICE_CONFIG') { void syncAlarm(); sendResponse({ ok: true }); return; }
  if (msg?.type === 'GET_LOGS') {
    chrome.storage.local.get('logs').then((d) => sendResponse({ logs: d.logs || [] }));
    return true; // async
  }
});
