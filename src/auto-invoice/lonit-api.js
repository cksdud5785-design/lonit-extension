// 목적: Lonit API 클라이언트 — 확장이 X-Auth-Key 헤더로 주문 API 호출 (tenant.ts 가 user_settings.auth_key 로 인증).
// 더망고 admin 조종 대신 전부 Lonit 자사 API. 마켓 전송은 검증된 bulk/send-tracking 레일 재사용.

const API_BASE = 'https://api.lonit.kr/api/v1';

async function authKey() {
  // 기존 Lonit 수집확장과 동일 키 공유 (popup.js 가 'authKey' 로 저장). lonitAuthKey 도 하위호환 조회.
  const { authKey, lonitAuthKey } = await chrome.storage.local.get(['authKey', 'lonitAuthKey']);
  return authKey || lonitAuthKey || '';
}

async function apiCall(path, options = {}) {
  const key = await authKey();
  if (!key) throw new Error('인증 KEY 미설정 (팝업에서 서비스 KEY 입력)');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Key': key,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('인증 실패 (KEY 확인)');
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${t.slice(0, 120)}`);
  }
  return res.json();
}

/** 무신사 송장 대기 주문 큐 — 송장 미입력 + 발주확인/배송대기 상태. (서버 오케스트레이터 모델) */
export async function fetchMusinsaPendingOrders() {
  // ★ 무신사는 소싱처(sourceMarket) — 판매마켓(market: 쿠팡/네이버 등)이 아님. (검수: market=musinsa=0건)
  const params = new URLSearchParams({
    sourceMarket: 'musinsa',
    viewFilter: 'tracking_not_entered',
    status: 'payment_completed,payment_complete,shipping_pending,shipping_wait',
    limit: '200',
    page: '1',
    sortBy: 'ordered_at',
    sortDir: 'asc',
  });
  const res = await apiCall(`/orders?${params.toString()}`);
  return (res.data || [])
    .filter((o) => o.sourceOrderNo && String(o.sourceOrderNo).trim()) // 무신사 주문번호 있는 건만 (매칭키)
    .map((o) => ({
    orderId: o.id,
    sourceOrderNo: o.sourceOrderNo, // 무신사 주문번호 (매칭키)
    marketOrderId: o.marketOrderId,
    orderNo: o.orderNo,
    productName: o.productName,
  }));
}

/** 송장 저장 (더망고 save_value 대체) — bulk-inline 단건 */
export async function saveTracking(orderId, trackingCompany, trackingNumber) {
  return apiCall('/orders/bulk-inline', {
    method: 'PATCH',
    body: JSON.stringify({ items: [{ orderId, trackingCompany, trackingNumber }] }),
  });
}

/** 마켓 송장 전송 (더망고 send_delivery_info 대체) — 검증된 레일. 상태 승격은 서버 부수효과 */
export async function sendTrackingToMarket(orderId) {
  return apiCall('/orders/bulk/send-tracking', {
    method: 'POST',
    body: JSON.stringify({ orderIds: [orderId] }),
  });
}

/** 자동송장 설정 (v2 패널과 동일 소스) */
export async function fetchAutoInvoiceSettings() {
  const res = await apiCall('/orders/auto-invoice/settings');
  return res.data;
}
