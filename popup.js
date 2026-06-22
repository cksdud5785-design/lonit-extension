/**
 * BulkFlow 확장프로그램 — 팝업
 * 인증 KEY + ON/OFF만
 */

const API_URL = 'https://api.lonit.kr'; // 프로덕션 API 고정

async function getApiUrl() {
  return API_URL;
}

document.addEventListener('DOMContentLoaded', async () => {
  const config = await chrome.storage.local.get(['authKey', 'collectEnabled', 'musinsaLoginWarning']);
  document.getElementById('authKey').value = config.authKey || '';
  document.getElementById('collectToggle').checked = config.collectEnabled ?? false;
  updateMusinsaWarning(config.musinsaLoginWarning || '');

  // 대시보드 링크
  const apiUrl = await getApiUrl();
  // 프로덕션: api.lonit.kr -> www.lonit.kr / 개발: localhost:4000 -> localhost:3000
  const dashUrl = 'https://www.lonit.kr';
  document.getElementById('openDashboard').href = dashUrl;
  document.getElementById('openDashboard').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: dashUrl });
  });

  // 연결 확인
  if (config.authKey) checkConnection(config.authKey);

  // #7b: 현재 탭이 무신사 상품 페이지이면 push 버튼 표시
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = activeTab?.url ?? '';
    const isMusinsaProduct = /musinsa\.com\/products\/\d+/.test(currentUrl);
    if (isMusinsaProduct) {
      document.getElementById('pushBtn').style.display = '';
      document.getElementById('pushHint').style.display = '';
    }

    document.getElementById('pushBtn').addEventListener('click', async () => {
      const btn = document.getElementById('pushBtn');
      btn.disabled = true;
      btn.textContent = '⏳ 스크랩 중...';
      updateStatus('idle', '무신사 상품 스크랩 중...');
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'MUSINSA_PUSH_CURRENT',
          url: currentUrl,
        });
        if (result?.ok) {
          const title = result.received?.title ?? '';
          updateStatus('on', `✅ push 완료: ${title}`);
          btn.textContent = '✅ push 완료';
        } else {
          updateStatus('off', `❌ push 실패: ${result?.error ?? '알 수 없는 오류'}`);
          btn.textContent = '❌ 실패 (다시 시도)';
          btn.disabled = false;
        }
      } catch (err) {
        updateStatus('off', `오류: ${err.message}`);
        btn.textContent = '❌ 실패 (다시 시도)';
        btn.disabled = false;
      }
    });
  } catch {
    // 탭 쿼리 실패 무시 (popup에서 tabs API 권한 문제 등)
  }

  // 저장
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const authKey = document.getElementById('authKey').value.trim();
    if (!authKey) { alert('인증 KEY를 입력해주세요.'); return; }
    await chrome.storage.local.set({ authKey });
    chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    checkConnection(authKey);
  });

  // ON/OFF
  document.getElementById('collectToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ collectEnabled: enabled });
    chrome.runtime.sendMessage({ type: enabled ? 'ENABLE_COLLECT' : 'DISABLE_COLLECT' });
    updateStatus(enabled ? 'on' : 'idle', enabled ? '수집 활성화됨' : '수집 비활성화');
  });

  // 2026-06-12: 업데이트 모니터 — 서비스워커 처리량/차단/적응딜레이를 2초마다 갱신.
  startUpdateMonitor();
});

function startUpdateMonitor() {
  const panel = document.getElementById('updateMonitor');
  const rows = document.getElementById('monRows');
  const ssgEl = document.getElementById('monSsg');
  if (!panel || !rows) return;
  const fmtAgo = (ts) => {
    if (!ts) return '-';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}초 전`;
    if (s < 3600) return `${Math.round(s / 60)}분 전`;
    return `${Math.round(s / 3600)}시간 전`;
  };
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const render = (stats) => {
    const markets = stats?.markets ?? {};
    const keys = Object.keys(markets);
    if (keys.length === 0) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    const ssg = stats.ssg ?? {};
    const ssgFloor = ssg.safeFloorMs ? ` (바닥 ${Math.round(ssg.safeFloorMs / 100) / 10}s)` : '';
    ssgEl.textContent = ssg.blockedForMs > 0
      ? `SSG 차단쿨다운 ${Math.ceil(ssg.blockedForMs / 1000)}초`
      : `SSG 딜레이 ${Math.round((ssg.delayMs ?? 0) / 100) / 10}s${ssgFloor}`;
    rows.innerHTML = '';
    // GAP-3: 전송 실패(splice 후 유실)는 사용자에게 silent 였음 → 상단 경고.
    const rcv = stats.receive ?? {};
    if (rcv.fail > 0) {
      rows.insertAdjacentHTML('beforeend',
        `<span style="font-weight:600;color:#dc2626">전송실패</span>` +
        `<span style="color:#dc2626">누적 ${rcv.fail}회 · 최근유실 ${rcv.lastLostCount ?? 0}건</span>` +
        `<span style="color:#dc2626" title="${esc(rcv.lastError || '')}">${fmtAgo(rcv.lastErrorAt)}</span>`,
      );
    }
    for (const m of keys) {
      const s = markets[m];
      const blockTxt = s.blocks > 0
        ? `<span style="color:#dc2626" title="${esc(s.lastBlockReason || '')}">차단 ${s.blocks}</span>` // GAP-2: 사유 hover
        : `<span style="color:#9ca3af">차단 0</span>`;
      // GAP-1: 재고 미신뢰(=마켓에 재고 미푸시) 건수. 품절표기 과다(lost-sale) 가능 신호.
      const relTxt = s.stockReliableFalse > 0
        ? ` · <span style="color:#d97706" title="재고 미신뢰 = 해당 건 재고를 마켓에 안 보냄(오버셀링 방지, 단 품절표기 과다 가능)">재고미신뢰 ${s.stockReliableFalse}</span>`
        : '';
      rows.insertAdjacentHTML('beforeend',
        `<span style="font-weight:600">${esc(m)}</span>` +
        `<span>${s.perMinute}/분 · 누적 ${s.ok}✓/${s.fail}✗${relTxt}</span>` +
        `<span>${blockTxt} · ${fmtAgo(s.lastEventAt)}</span>`,
      );
    }
  };
  const poll = () => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_UPDATE_STATS' }, (stats) => {
        if (chrome.runtime.lastError) return; // SW 미기동 등 무시
        if (stats) render(stats);
      });
    } catch { /* 무시 */ }
  };
  poll();
  setInterval(poll, 2000);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.musinsaLoginWarning) return;
  updateMusinsaWarning(changes.musinsaLoginWarning.newValue || '');
});

async function checkConnection(authKey) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  try {
    const apiUrl = await getApiUrl();
    const res = await fetch(`${apiUrl}/api/v1/collect/pending`, {
      headers: { 'X-Auth-Key': authKey },
    });
    if (res.ok) {
      const enabled = document.getElementById('collectToggle').checked;
      updateStatus(enabled ? 'on' : 'idle', enabled ? '연결됨 — 수집 활성화' : '연결됨 — 수집 비활성화');
    } else if (res.status === 401) {
      updateStatus('off', '인증 KEY가 올바르지 않습니다');
    } else {
      updateStatus('off', '서버 연결 실패');
    }
  } catch {
    updateStatus('off', '서버에 연결할 수 없습니다');
  }
}

function updateStatus(state, message) {
  document.getElementById('statusDot').className = `dot ${state}`;
  document.getElementById('statusText').textContent = message;
  document.getElementById('statusText').className = `status-text${state === 'on' ? ' on' : ''}`;
}

function updateMusinsaWarning(message) {
  const el = document.getElementById('musinsaWarning');
  if (!el) return;
  const text = String(message || '').trim();
  el.style.display = text ? '' : 'none';
  el.textContent = text;
}

