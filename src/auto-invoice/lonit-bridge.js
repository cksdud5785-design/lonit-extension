// 목적: www.lonit.kr (주문관리 v2) ↔ 확장 background 브릿지 content script.
// v2 AutoInvoicePanel 이 window.postMessage 로 보낸 메시지를 chrome.runtime 으로 중계, 응답을 되돌린다.
// (확장은 externally_connectable 미사용 — content script 가 유일한 안전한 web↔ext 통로)

console.log('[Lonit 자동송장] 브릿지 주입됨 (lonit.kr)');
// 주입 즉시 + 약간 지연 후 READY 브로드캐스트 (패널 mount 타이밍과 무관하게 연결 인지)
function announceReady() { try { window.postMessage({ type: 'LONIT_AUTO_INVOICE_BRIDGE_READY' }, '*'); } catch (e) {} }
announceReady();
setTimeout(announceReady, 300);

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data.type !== 'string') return;
  const { type } = e.data;
  if (!type.startsWith('LONIT_AUTO_INVOICE_')) return;

  // PING → background 확인 후 PONG 회신 (v2 가 확장 연결상태 표시)
  if (type === 'LONIT_AUTO_INVOICE_PING') {
    chrome.runtime.sendMessage({ type: 'LONIT_AUTO_INVOICE_PING' }, (res) => {
      if (chrome.runtime.lastError) return; // 확장 없음
      if (res?.pong) window.postMessage({ type: 'LONIT_AUTO_INVOICE_PONG' }, '*');
    });
    return;
  }
  // RUN_NOW / CONFIG → background 로 중계
  if (type === 'LONIT_AUTO_INVOICE_RUN_NOW' || type === 'LONIT_AUTO_INVOICE_CONFIG') {
    chrome.runtime.sendMessage({ type, payload: e.data }, () => void chrome.runtime.lastError);
  }
});
