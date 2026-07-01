// 목적: chrome.debugger(CDP)로 소싱처 체크아웃을 trusted 이벤트로 자동 구동(주문시작 Tier-2).
// 콘텐츠스크립트는 isTrusted:false 라 무신사 Radix 옵션 드롭다운을 못 여는데, CDP Input.* 은
// 브라우저 레벨 trusted 이벤트(수동 클릭과 동일)라 구동 가능.
// 범위: 옵션(사이즈) 선택 → 구매하기 → 주문서 → 배송지(고객주소 saveAction 생성) → 결제 직전 정지.
// 배송지는 Daum 위젯 불필요(라이브 실증 2026-07-02): order-service saveAction 이 raw
// (zipcode,address1) 쌍을 우편DB 로 직접 검증·수용한다. 단 address1 은 Daum 축약형 기본주소만
// 통과(시도 축약, 건물명/상세 미포함) → buildAddressCandidates 로 후보 사다리를 만들어 순차 시도.
// spec: docs/superpowers/specs/2026-07-01-sourcing-order-autofill-design.md

const CDP_PROTOCOL = '1.3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- chrome.debugger 프로미스 래퍼 ----
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error('attach: ' + err.message));
      else resolve();
    });
  });
}
function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
  });
}
function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(method + ': ' + err.message));
      else resolve(result);
    });
  });
}

// ---- CDP 기본 동작 ----
async function evaluate(tabId, expression) {
  const res = await dbgSend(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) {
    const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval error';
    throw new Error('evaluate: ' + text);
  }
  return res && res.result ? res.result.value : undefined;
}
async function waitFor(tabId, expression, { timeout = 12000, interval = 300 } = {}) {
  const start = Date.now();
  const guarded = `(function(){try{return (${expression})}catch(e){return null}})()`;
  for (;;) {
    const v = await evaluate(tabId, guarded);
    if (v) return v;
    if (Date.now() - start >= timeout) throw new Error('waitFor timeout: ' + expression.slice(0, 50));
    await sleep(interval);
  }
}
async function clickAt(tabId, x, y) {
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 });
}
// finderExpr: Element 반환 식 → 화면 중심 좌표. 팝업 옵션엔 scroll 쓰지 말 것(Radix 닫힘).
async function centerOf(tabId, finderExpr) {
  const expr = `(function(){var el=(${finderExpr});if(!el)return null;var r=el.getBoundingClientRect();`
    + `if(r.width<=0||r.height<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
  return evaluate(tabId, expr);
}
async function clickElement(tabId, finderExpr, label) {
  const c = await centerOf(tabId, finderExpr);
  if (!c) throw new Error('요소 없음/안보임: ' + (label || finderExpr.slice(0, 40)));
  await clickAt(tabId, c.x, c.y);
  return c;
}

// ---- finder 식(페이지 컨텍스트) ----
const F_SIZE_TRIGGER = `document.querySelector('input[placeholder="사이즈"]')`;
const F_BUY = `[].find.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').trim()==='구매하기'})`;

// ---- 배송지(주소) 헬퍼 ----
// saveAction/updateAction 은 (zipcode, address1) 쌍을 우편DB 로 검증하며, 실패·레이트리밋 모두
// 동일 문구("일시적인 문제가 발생하였습니다")를 반환한다 → 후보는 간격을 두고 순차 시도.
// 시도(광역단체)명은 Daum 축약형("인천 부평구 …")만 통과, 풀네임("인천광역시 …")은 거부됨(실측).
const SIDO_SHORT = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
  '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원',
  '충청북도': '충북', '충청남도': '충남', '전북특별자치도': '전북', '전라북도': '전북',
  '전라남도': '전남', '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주', '제주도': '제주',
};

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return String(p || '').trim();
}

function shortSido(a) {
  const s = String(a || '').trim();
  for (const k of Object.keys(SIDO_SHORT)) {
    if (s.startsWith(k)) return SIDO_SHORT[k] + s.slice(k.length);
  }
  return s;
}

// 마켓주문 receiver_address 는 "기본주소+건물명+상세" 합본이 흔함(예: "인천광역시 부평구 산곡동 222
// 한신휴아파트 102동 1304호") → 통과 가능성 순서로 후보 사다리 생성. 최종 검증은 saveAction 이 한다.
export function buildAddressCandidates(address, detail) {
  const raw = String(address || '').trim();
  const det = String(detail || '').trim();
  let base = raw;
  if (det && base.endsWith(det)) base = base.slice(0, base.length - det.length).trim();
  else if (det && base.includes(det)) base = base.replace(det, ' ').replace(/\s+/g, ' ').trim();
  const noParen = base.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const s = shortSido(noParen).replace(/([동리가])(\d)/, '$1 $2'); // "산곡동222"→"산곡동 222"
  // 도로명: 마지막 "…로/길 번호(-부번)" 까지(도로명 내부 숫자 "동일로237나길" 은 greedy 로 통과).
  const road = s.match(/^(.+(?:로|길)\s*\d+(?:-\d+)?)(?=\s|\(|$)/);
  // 지번: 마지막 "…동/리/가 (산)번지(-부번)" 까지.
  const jibun = s.match(/^(.+[동리가]\s+(?:산\s*)?\d+(?:-\d+)?)(?=\s|\(|$)/);
  const cands = [];
  const push = (a1) => {
    const v = String(a1 || '').trim();
    if (!v || cands.some((c) => c.address1 === v)) return;
    const rest = s.startsWith(v) ? s.slice(v.length).trim() : '';
    cands.push({ address1: v, address2: [rest, det].filter(Boolean).join(' ').trim() || det });
  };
  if (road) push(road[1]);
  if (jibun) push(jibun[1]);
  push(s);
  push(raw);
  return cands;
}

// order-service 주소 API 호출식(주문서 탭 페이지 컨텍스트에서 same-origin+쿠키로 실행).
function addrPostExpr(path, bodyObj) {
  return `(async function(){try{`
    + `var body=${JSON.stringify(bodyObj)};body.originReferrer=location.href;`
    + `var res=await fetch('https://www.musinsa.com/order-service/my/addresses/${path}',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});`
    + `var j=null;try{j=await res.json();}catch(e){}`
    + `return {status:res.status,result:!!(j&&j.result),id:(j&&j.data)||null,message:(j&&j.message)||''};`
    + `}catch(e){return {status:0,result:false,id:null,message:String(e&&e.message||e)};}})()`;
}

// 우리가 생성한 소싱 배송지 id 추적(chrome.storage) — 다음 런에서 삭제해 주소록 누적 방지.
// 추적된 id 외에는 어떤 주소도 절대 수정·삭제하지 않는다(사용자 기존 주소 불가침).
const ADDR_TRACK_KEY = 'sourcingAddressIds';
async function getTrackedAddrIds() {
  try {
    const o = await chrome.storage.local.get(ADDR_TRACK_KEY);
    return Array.isArray(o[ADDR_TRACK_KEY]) ? o[ADDR_TRACK_KEY].map(Number).filter(Boolean) : [];
  } catch (e) { return []; }
}
async function setTrackedAddrIds(ids) {
  try { await chrome.storage.local.set({ [ADDR_TRACK_KEY]: ids }); } catch (e) { void e; }
}

// 옵션 행 finder: 옵션 컨테이너 텍스트는 "M모레(금) 도착보장" 처럼 합쳐져 firstToken 실패 →
// "textContent 가 정확히 사이즈인 leaf(예: 'M' span)" 를 찾고 그 클릭가능 조상을 반환. 뷰포트 안만.
function fOptionRow(size) {
  const s = JSON.stringify(String(size).replace(/\s+/g, '').toUpperCase());
  // 옵션 텍스트는 "M내일(금) 도착보장" 통짜 → 선두 사이즈 토큰 매칭(뒤가 영숫자/하이픈이면 제외:
  // "MUSINSA"(로고), "M-65 필드 재킷"(색상변형) 걸러냄). 클릭가능 + 뷰포트 안만.
  return `(function(){`
    + `var want=${s};var vh=window.innerHeight;`
    + `var sizeRe=/^(4XL|3XL|2XL|XL|XS|S|M|L)(?![A-Z0-9-])/;`
    + `var lead=function(t){var m=String(t||'').replace(/\\s+/g,'').toUpperCase().match(sizeRe);return m?m[1]:null;};`
    + `var isClk=function(e){if(!e||!e.tagName)return false;if(e.tagName==='LI'||e.tagName==='BUTTON'||e.tagName==='A')return true;`
    + `var role=e.getAttribute&&e.getAttribute('role');if(role==='option'||role==='menuitem'||role==='menuitemradio')return true;`
    + `try{return getComputedStyle(e).cursor==='pointer';}catch(_){return false;}};`
    + `var els=document.querySelectorAll('li,button,a,div,span,[role]');var cands=[];`
    + `for(var i=0;i<els.length;i++){var e=els[i];var t=(e.textContent||'').trim();if(!t||t.length>30)continue;`
    + `if(lead(t)!==want||!isClk(e))continue;`
    + `var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0||r.height>90||r.top<0||r.top>vh)continue;cands.push(e);}`
    + `cands.sort(function(a,b){return a.getBoundingClientRect().top-b.getBoundingClientRect().top;});`
    + `return cands[0]||null;})()`;
}

// 옵션 미발견 시 진단: 화면에 보이는 사이즈-유사 텍스트 요소 덤프.
function fSizeCandidates(size) {
  const s = JSON.stringify(String(size));
  return `(function(){var want=String(${s}).replace(/\\s+/g,'').toUpperCase();var vh=window.innerHeight;`
    + `var out=[];var all=document.querySelectorAll('span,li,button,div,a,[role]');`
    + `for(var i=0;i<all.length&&out.length<12;i++){var e=all[i];var t=(e.textContent||'').trim();`
    + `if(t.length>18||t.replace(/\\s+/g,'').toUpperCase().indexOf(want)!==0)continue;`
    + `var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;`
    + `var cur='';try{cur=getComputedStyle(e).cursor}catch(_){}`
    + `out.push({tag:e.tagName,text:t.slice(0,16),top:Math.round(r.top),h:Math.round(r.height),inView:(r.top>=0&&r.top<=vh),cursor:cur});}`
    + `return {vh:vh, items:out};})()`;
}

const F_SELECTED = `(/총\\s*\\d+\\s*개/.test(document.body.innerText||'')) ? 1 : 0`;
function fDescribe(finderExpr) {
  return `(function(){var el=(${finderExpr});if(!el)return null;var r=el.getBoundingClientRect();`
    + `return {tag:el.tagName,text:(el.textContent||'').trim().slice(0,24),top:Math.round(r.top),h:Math.round(r.height)};})()`;
}
const DIAG_EXPR = `(function(){var t=document.querySelector('input[placeholder="사이즈"]');`
  + `return {url:location.href, sizeValue:t?(t.value||''):null, hasTotal:/총\\s*\\d+\\s*개/.test(document.body.innerText||'')};})()`;

/**
 * 옵션(사이즈) 선택 → 구매하기 → 주문서 도달. CDP trusted 이벤트.
 * @returns {Promise<object>} {ok, stage, ...진단}
 */
export async function cdpSelectOptionAndBuy(tabId, targetSize, opts = {}) {
  await dbgAttach(tabId);
  try {
    // 0) 탭 렌더 대기(innerHeight>0). 백그라운드/미포커스 탭은 innerHeight=0 이라 좌표 클릭 무효.
    await waitFor(tabId, `window.innerHeight > 100 ? 1 : 0`, { timeout: 10000 }).catch(() => {});
    // 1) 로드 대기 + 트리거 뷰포트 중앙(팝업이 화면 안에 뜨도록).
    await waitFor(tabId, `${F_SIZE_TRIGGER} ? 1 : 0`, { timeout: 15000 });
    await evaluate(tabId, `(function(){var t=${F_SIZE_TRIGGER};if(t&&t.scrollIntoView)t.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
    await sleep(400);
    // 2) 드롭다운 열기(trusted).
    await clickElement(tabId, F_SIZE_TRIGGER, '사이즈 트리거');
    // 3) 옵션 등장 폴링(직접) → 실패 시 후보 덤프 반환.
    const rowFinder = fOptionRow(targetSize);
    let optCenter = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) { optCenter = await centerOf(tabId, rowFinder); if (optCenter) break; await sleep(300); }
    if (!optCenter) {
      const sizeCandidates = await evaluate(tabId, fSizeCandidates(targetSize)).catch(() => null);
      return { ok: false, stage: 'option_not_found', sizeCandidates };
    }
    const optionMatched = await evaluate(tabId, fDescribe(rowFinder)).catch(() => null);
    // 4) 옵션 클릭(스크롤 금지) → 선택 검증(총 N개).
    await clickAt(tabId, optCenter.x, optCenter.y);
    let selected = 0;
    try { selected = await waitFor(tabId, F_SELECTED, { timeout: 4000 }); } catch (e) { selected = 0; }
    if (!selected) {
      const diag = await evaluate(tabId, DIAG_EXPR).catch(() => null);
      return { ok: false, stage: 'option_not_selected', optionMatched, diag };
    }
    // 5) 구매하기 → 주문서.
    await clickElement(tabId, F_BUY, '구매하기');
    try {
      await waitFor(tabId, `location.href.indexOf('/order/order-form')>=0 ? 1 : 0`, { timeout: 20000 });
    } catch (e) {
      const diag = await evaluate(tabId, DIAG_EXPR).catch(() => null);
      return { ok: false, stage: 'no_order_form', optionMatched, diag };
    }
    // 6) 배송지: 고객주소를 saveAction 으로 신규 생성(isDefault:true) → 주문서 재로드 → 표시 검증.
    //    updateAction 은 address1 변경을 거부하므로(실측) 기존 슬롯 덮어쓰기가 아닌 "생성+기본지정".
    //    사용자 기존 주소는 절대 수정·삭제하지 않고, 우리가 만든 id 만 추적해 다음 런에서 삭제.
    if (opts.recipient) {
      const rc = opts.recipient;
      const name = String(rc.name || '').trim();
      const mobile = normPhone(rc.phone);
      const zipcode = String(rc.zipcode || '').replace(/\D/g, '');
      if (!name || !mobile || zipcode.length !== 5 || !String(rc.address || '').trim()) {
        return { ok: false, stage: 'recipient_incomplete', optionMatched,
          missing: { name: !name, mobile: !mobile, zipcode: zipcode.length !== 5, address: !String(rc.address || '').trim() } };
      }
      const candidates = buildAddressCandidates(rc.address, rc.addressDetail);
      let addressSave = null;
      const attempts = [];
      for (const cand of candidates.slice(0, 4)) {
        const body = { name, mobile, zipcode, address1: cand.address1, address2: cand.address2, isDefault: true, additionalMessage: '', additionalMessageManual: '' };
        let res = null;
        try { res = await evaluate(tabId, addrPostExpr('saveAction', body)); } catch (e) { res = { status: 0, result: false, id: null, message: String(e && e.message || e) }; }
        attempts.push({ address1: cand.address1, status: res && res.status, message: res && res.message });
        if (res && res.result && res.id) { addressSave = { id: res.id, address1: cand.address1, address2: cand.address2 }; break; }
        await sleep(1500); // 검증실패/레이트리밋 문구가 동일 → 간격 두고 다음 후보
      }
      if (!addressSave) {
        // fail-loud: 배송지 미설정 상태로 delivery_set 을 반환하지 않는다(사용자 수동 입력 필요).
        return { ok: false, stage: 'address_create_failed', optionMatched, attempts };
      }
      // 이전 런의 소싱 주소 정리(새 슬롯이 기본이 된 뒤라 비-기본 삭제 안전).
      // 이미 없는 id 는 삭제가 result:false 라(멱등 아님, 실측) 목록 교차확인으로 추적서 제거.
      const prevIds = (await getTrackedAddrIds()).filter((id) => id !== addressSave.id);
      let remaining = [];
      for (const id of prevIds) {
        const del = await evaluate(tabId, addrPostExpr('deleteMemberAddress', { id })).catch(() => null);
        if (!del || !del.result) remaining.push(id);
      }
      if (remaining.length) {
        const existing = await evaluate(tabId,
          `(async function(){try{var l=await fetch('https://www.musinsa.com/order-service/my/addresses/getMemberAddresses',{credentials:'include',headers:{'Accept':'application/json'}}).then(function(x){return x.json();});`
          + `return ((l&&l.data&&l.data.addresses)||[]).map(function(a){return a.id;});}catch(e){return null;}})()`).catch(() => null);
        if (Array.isArray(existing)) remaining = remaining.filter((id) => existing.includes(id));
      }
      await setTrackedAddrIds([addressSave.id, ...remaining]);
      // 주문서 재로드 → 새 기본배송지(수령인명) 표시 검증(fail-loud).
      await evaluate(tabId, 'location.reload()').catch(() => {});
      await sleep(2000);
      await waitFor(tabId, `(location.href.indexOf('/order/order-form')>=0 && !!document.body) ? 1 : 0`, { timeout: 15000 }).catch(() => {});
      let shown = 0;
      try { shown = await waitFor(tabId, `((document.body.innerText||'').indexOf(${JSON.stringify(name)})>=0) ? 1 : 0`, { timeout: 8000 }); } catch (e) { shown = 0; }
      if (!shown) {
        return { ok: false, stage: 'recipient_not_shown', optionMatched, addressSave, attempts };
      }
      return { ok: true, stage: 'delivery_set', optionMatched, addressSave, attempts };
    }
    return { ok: true, stage: 'order_form', optionMatched };
  } finally {
    await dbgDetach(tabId);
  }
}
