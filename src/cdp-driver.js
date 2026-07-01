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
const F_BUY = `[].find.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').trim()==='구매하기'})`;

// ---- 옵션 매칭(STRICT, spec ⑥) ----
// 마켓주문 옵션 문자열("옵션:BEG/095-1개", "…, 120, 기타 x1", "사이즈: 270", "WHT/000" 등)을
// 토큰으로 분해해 무신사 옵션 API(optionItems)와 대조 → 유일 아이템만 확정, 모호하면 STOP.
export function parseOptionTokens(opt) {
  let s = String(opt || '').trim();
  s = s.replace(/^옵션\s*[::]\s*/i, '').replace(/^사이즈\s*[::]\s*/i, '');
  s = s.replace(/\s*[xX×]\s*\d+\s*$/, '').replace(/\s*-\s*\d+\s*개\s*$/, '');
  return s.split(/[\/,]/).map((t) => t.trim()).filter(Boolean);
}
const normOpt = (t) => String(t || '').replace(/\s+/g, '').toUpperCase();

// items: [{no, values:[string]}] (활성만). 규칙: ①아이템이 1개뿐이면 그것(옵션 없는 상품 포함)
// ②모든 차원 값이 주문 토큰에 포함되는 아이템이 정확히 1개면 그것 ③그 외 null(fail-loud).
export function matchOptionItem(items, orderOption) {
  const active = Array.isArray(items) ? items : [];
  if (active.length === 1) return { item: active[0], reason: 'single' };
  const tokens = parseOptionTokens(orderOption).map(normOpt);
  const hits = active.filter((it) => it.values.length > 0 && it.values.every((v) => tokens.includes(normOpt(v))));
  if (hits.length === 1) return { item: hits[0], reason: 'token' };
  return { item: null, reason: hits.length === 0 ? 'no_match' : 'ambiguous', hitCount: hits.length };
}

// 옵션 메타(차원명 + 활성 아이템) — PDP 탭에서 same-origin CORS 로 조회.
function optionsFetchExpr(goodsNo) {
  return `(async function(){try{`
    + `var r=await fetch('https://goods-detail.musinsa.com/api2/goods/${Number(goodsNo)}/options?goodsSaleType=SALE',{credentials:'include',headers:{'Accept':'application/json'}});`
    + `var j=await r.json();var d=(j&&j.data)||{};var items=[];var arr=d.optionItems||[];`
    + `for(var i=0;i<arr.length;i++){var it=arr[i];if(it.isDeleted||it.activated===false)continue;`
    + `items.push({no:it.no,values:(it.optionValues||[]).map(function(v){return String(v.name||'');})});}`
    + `var dims=(d.basic||[]).map(function(b){return String(b.name||b.optionName||'');});`
    + `return {ok:true,dims:dims,items:items};}catch(e){return {ok:false,err:String(e&&e.message||e)};}})()`;
}

// 차원 드롭다운 트리거: placeholder==차원명 우선(사이즈/색상/Size/C/S…), 폴백=빈 값의 readonly 입력.
function fDimTrigger(dim) {
  return `(function(){var el=document.querySelector('input[placeholder='+JSON.stringify(${JSON.stringify(String(dim))})+']');`
    + `if(el){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)return el;}`
    + `var ins=document.querySelectorAll('input[placeholder]');`
    + `for(var i=0;i<ins.length;i++){var e=ins[i];var r2=e.getBoundingClientRect();`
    + `if(r2.width>100&&r2.height>0&&!e.value&&(e.readOnly||e.hasAttribute('readonly')))return e;}`
    + `return null;})()`;
}

// 수량 스테퍼: [BUTTON(−), INPUT(readonly,값), BUTTON(+)] 구조(실측) → input 의 다음 형제가 '+'.
const F_QTY_INPUT = `[].find.call(document.querySelectorAll('input'),function(e){var r=e.getBoundingClientRect();return r.width>0&&r.width<60&&(e.readOnly||e.hasAttribute('readonly'))&&/^\\d+$/.test(e.value||'');})`;
const F_QTY_PLUS = `(function(){var inp=${F_QTY_INPUT};if(!inp)return null;var nb=inp.nextElementSibling;return (nb&&nb.tagName==='BUTTON')?nb:null;})()`;
const QTY_VALUE_EXPR = `(function(){var inp=${F_QTY_INPUT};return inp?Number(inp.value):null;})()`;

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

// 시도 표기 변형 생성: 축약형 우선 + 원형 유지. "○○통합특별시"(행정개편명, 예: 전남광주통합특별시)는
// Daum 축약형이 불명이라 도시명(뒤 2자)·전체 축약 둘 다 시도.
function sidoVariants(a) {
  const s = String(a || '').trim();
  const out = [];
  const add = (v) => { if (v && !out.includes(v)) out.push(v); };
  for (const k of Object.keys(SIDO_SHORT)) {
    if (s.startsWith(k)) { add(SIDO_SHORT[k] + s.slice(k.length)); break; }
  }
  const m = s.match(/^([가-힣]{2,8})통합특별시(?=\s)/);
  if (m) { add(m[1].slice(-2) + s.slice(m[0].length)); add(m[1] + s.slice(m[0].length)); }
  add(s);
  return out;
}

// 마켓주문 receiver_address 는 "기본주소+건물명+상세" 합본이 흔함(예: "인천광역시 부평구 산곡동 222
// 한신휴아파트 102동 1304호") → 통과 가능성 순서로 후보 사다리 생성. 최종 검증은 saveAction 이 한다.
// detail 이 기본주소 일부를 잘라먹는 케이스("다대로429번길 20, 209동…" 의 detail "20, 209동…")가
// 있어 detail-제거본과 원문 둘 다에서 추출한다. 경계는 공백/쉼표/괄호.
export function buildAddressCandidates(address, detail) {
  const raw = String(address || '').trim();
  const det = String(detail || '').trim();
  let base = raw;
  if (det && base.endsWith(det)) base = base.slice(0, base.length - det.length).trim();
  else if (det && base.includes(det)) base = base.replace(det, ' ').replace(/\s+/g, ' ').trim();
  const srcs = [];
  for (const b of base !== raw ? [base, raw] : [base]) {
    const noParen = b.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    for (const v of sidoVariants(noParen)) {
      const s = v.replace(/([동리가])(\d)/, '$1 $2'); // "산곡동222"→"산곡동 222"
      if (!srcs.includes(s)) srcs.push(s);
    }
  }
  const cands = [];
  const push = (a1, src) => {
    const v = String(a1 || '').trim().replace(/,+$/, '');
    if (!v || cands.some((c) => c.address1 === v)) return;
    const rest = src && src.startsWith(v) ? src.slice(v.length).replace(/^[\s,]+/, '').trim() : '';
    cands.push({ address1: v, address2: [rest, det].filter(Boolean).join(' ').trim() || det });
  };
  for (const s of srcs) {
    // 도로명: 마지막 "…로/길 번호(-부번)" 까지(도로명 내부 숫자 "동일로237나길" 은 greedy 로 통과).
    const road = s.match(/^(.+(?:로|길)\s*\d+(?:-\d+)?)(?=[\s,(]|$)/);
    if (road) push(road[1], s);
  }
  for (const s of srcs) {
    // 지번: 마지막 "…동/리/가 (산)번지(-부번)" 까지.
    const jibun = s.match(/^(.+[동리가]\s+(?:산\s*)?\d+(?:-\d+)?)(?=[\s,(]|$)/);
    if (jibun) push(jibun[1], s);
  }
  for (const s of srcs) push(s, s);
  push(raw, raw);
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

// 옵션 행 finder: 드롭다운 행 텍스트는 "M내일(금) 도착보장" 처럼 값+배송문구 통짜 → "행 텍스트가
// 목표 값으로 시작"으로 매칭. 오탐 방지 2중: ①같은 차원의 더 긴 값이 우선 매칭되면 제외
// ("2XL" 행이 "XL" 로 안 잡힘) ②값 뒤 문자가 라틴 영숫자면 제외("M"→"MUSINSA" 차단).
function fOptionRowByValue(value, allValues) {
  const want = value == null ? null : normOpt(value); // null = 아무 값 행이나(드롭다운 열림 감지용)
  const all = [...new Set(allValues.map(normOpt).filter(Boolean))].sort((a, b) => b.length - a.length);
  return `(function(){`
    + `var want=${JSON.stringify(want)};var all=${JSON.stringify(all)};var vh=window.innerHeight;`
    + `var norm=function(t){return String(t||'').replace(/\\s+/g,'').toUpperCase();};`
    + `var isClk=function(e){if(!e||!e.tagName)return false;if(e.tagName==='LI'||e.tagName==='BUTTON'||e.tagName==='A')return true;`
    + `var role=e.getAttribute&&e.getAttribute('role');if(role==='option'||role==='menuitem'||role==='menuitemradio')return true;`
    + `try{return getComputedStyle(e).cursor==='pointer';}catch(_){return false;}};`
    + `var els=document.querySelectorAll('li,button,a,div,span,[role]');var cands=[];`
    + `for(var i=0;i<els.length;i++){var e=els[i];var t=norm(e.textContent);if(!t||t.length>60)continue;`
    + `var m=null;for(var k=0;k<all.length;k++){if(t.indexOf(all[k])===0){m=all[k];break;}}`
    + (want === null ? `if(m===null)continue;` : `if(m!==${JSON.stringify(want)})continue;`)
    // 경계문자: 라틴영숫자("MUSINSA")·쉼표/원("120,730원" 가격 오탐) 이면 옵션 행이 아님.
    + `var nx=t.charAt(m.length);if(nx&&/[A-Z0-9,원.]/.test(nx))continue;`
    + `if(!isClk(e))continue;`
    // 뷰포트 밖도 후보 유지(드롭다운 리스트는 스크롤 컨테이너 — 6개 이상이면 잘림) → reveal 로 노출.
    + `var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0||r.height>90)continue;cands.push(e);}`
    + `cands.sort(function(a,b){return a.getBoundingClientRect().top-b.getBoundingClientRect().top;});`
    + `return cands[0]||null;})()`;
}

// 행이 실제로 클릭 가능한지는 rect 만으로 부족 — 드롭다운 리스트는 스크롤 컨테이너라 rect 가
// 뷰포트 안이어도 리스트 클리핑 밖일 수 있음(그 좌표 클릭은 리스트 뒤 페이지에 떨어짐, 실측).
// 판정은 elementFromPoint 히트테스트로: 중심점의 최상위 요소가 행(또는 그 자손/조상)이어야 함.
// 주의: 히트가 el 의 "조상"인 경우, 키 큰 팝업 컨테이너(클리핑 밖 행도 contains)와 행 래퍼를
// 구분해야 함 → 조상 수용은 높이 <100px(행 크기)일 때만.
const HIT_TEST_FN = `var hitOk=function(el){var r=el.getBoundingClientRect();`
  + `if(r.width<=0||r.height<=0||r.top<0||r.bottom>window.innerHeight)return false;`
  + `var h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);`
  + `if(!h)return false;if(h===el||el.contains(h))return true;`
  + `return h.contains(el)&&h.getBoundingClientRect().height<100;};`;

// 히트 불가면 팝업 내부 스크롤 컨테이너만 스크롤해 노출(페이지 스크롤 금지 — 페이지가 움직이면
// Radix 팝업이 닫힘. 컨테이너 scrollTop 조작은 팝업 유지, 라이브 실증).
function revealRowExpr(rowFinder) {
  return `(function(){${HIT_TEST_FN}var el=(${rowFinder});if(!el)return 0;`
    + `if(hitOk(el))return 1;`
    + `var r=el.getBoundingClientRect();var sc=el.parentElement;`
    + `while(sc&&sc!==document.body){var st=getComputedStyle(sc);`
    + `if(/(auto|scroll)/.test(st.overflowY)&&sc.scrollHeight>sc.clientHeight+4)break;sc=sc.parentElement;}`
    + `if(!sc||sc===document.body)return 0;`
    + `var sr=sc.getBoundingClientRect();sc.scrollTop+=(r.top-(sr.top+sr.height/2-r.height/2));return 2;})()`;
}
// 히트테스트 통과 시에만 좌표 반환(아니면 클릭 금지).
function centerInViewExpr(finderExpr) {
  return `(function(){${HIT_TEST_FN}var el=(${finderExpr});if(!el)return null;`
    + `if(!hitOk(el))return null;var r=el.getBoundingClientRect();`
    + `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
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
const DIAG_EXPR = `(function(){var ph=[].map.call(document.querySelectorAll('input[placeholder]'),function(e){return e.placeholder+'='+(e.value||'');}).slice(0,6);`
  + `var qty=[].map.call(document.querySelectorAll('input'),function(e){var r=e.getBoundingClientRect();return (r.width>0&&r.width<60&&/^\\d+$/.test(e.value||''))?e.value:null;}).filter(Boolean);`
  + `var m=(document.body.innerText||'').match(/총\\s*\\d+\\s*개[^\\n]{0,20}/);`
  + `return {url:location.href, inputs:ph, qtyInputs:qty, totalSnippet:m?m[0]:null, ih:window.innerHeight};})()`;

// 차원 하나 선택: 트리거 클릭 → 행 폴링 → 클릭(스크롤 금지). allowOpenRow=true(2번째 차원부터)면
// 직전 선택으로 자동 열린 팝업의 행을 트리거 없이 바로 클릭(트리거 재클릭이 팝업을 닫는 것 방지).
async function selectDimValue(tabId, dim, value, allValues) {
  const rowFinder = fOptionRowByValue(value, allValues);
  const anyRow = fOptionRowByValue(null, allValues); // 드롭다운 열림 감지(아무 값 행)
  const trace = { dim, value, trigClicks: 0, rowClicks: 0, verified: false, dropdownSeen: false };
  const exists = async (f) => !!(await evaluate(tabId, `(${f}) ? 1 : 0`).catch(() => 0));
  // 선택 반영 신호(실측): 중간 차원은 선택되면 placeholder 입력이 styled div 로 교체돼 사라짐,
  // 마지막 차원은 아이템 카드 등장(총 N개). 입력칸 value 로는 감지 불가(값이 input 에 안 들어감).
  const dimDone = `((${F_SELECTED})${dim ? ` || !document.querySelector('input[placeholder='+JSON.stringify(${JSON.stringify(String(dim))})+']')` : ''}) ? 1 : 0`;
  const trig = fDimTrigger(dim);
  // 무신사 PDP 는 내비/스크롤 직후 첫 trusted 클릭이 무효되기도 함(실측) → 상태검증+재시도 루프.
  // 트리거는 "드롭다운이 안 열려 있을 때만" 클릭(열린 상태서 재클릭=토글로 닫혀버리는 레이스 방지).
  for (let attempt = 0; attempt < 4; attempt++) {
    let present = await exists(rowFinder);
    if (!present) {
      const open = await exists(anyRow);
      trace.dropdownSeen = trace.dropdownSeen || open;
      // attempt 2회째부터는 "열림" 판정을 불신하고 트리거를 강행 클릭(열림 오탐 → 영구 대기 방지).
      if (!open || attempt >= 2) {
        await waitFor(tabId, `(${trig}) ? 1 : 0`, { timeout: 8000 });
        await evaluate(tabId, `(function(){var t=(${trig});if(t&&t.scrollIntoView)t.scrollIntoView({block:'center',behavior:'instant'});return 1;})()`).catch(() => {});
        await sleep(400);
        try { await clickElement(tabId, trig, '옵션 트리거 ' + dim); trace.trigClicks += 1; } catch (e) { continue; }
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) { present = await exists(rowFinder); if (present) break; await sleep(300); }
      if (!present) continue; // 안 열렸거나(클릭 무효) 대상 행 없음 → 재시도
    }
    // 히트 불가(리스트 클리핑 밖)면 팝업 내부 스크롤로 노출 → 히트테스트 통과 좌표로만 클릭.
    let c = null;
    for (let k = 0; k < 3 && !c; k++) {
      await evaluate(tabId, revealRowExpr(rowFinder)).catch(() => {});
      await sleep(350);
      c = await evaluate(tabId, centerInViewExpr(rowFinder)).catch(() => null);
    }
    if (!c) continue;
    await clickAt(tabId, c.x, c.y);
    trace.rowClicks += 1;
    try {
      await waitFor(tabId, dimDone, { timeout: 3000 });
      trace.verified = true;
      return { c, trace };
    } catch (e) { /* 반영 안 됨 → 재시도 */ }
  }
  return { c: null, trace };
}

/**
 * 옵션 확정(API 대조 STRICT) → 차원별 선택 → 수량 → 구매하기 → 주문서 → 배송지 → 결제 직전 정지.
 * @param {number} tabId  PDP 탭
 * @param {string|number} goodsNo  무신사 상품번호
 * @param {string} orderOption  마켓주문 옵션 원문(형식 자유 — 토큰 매칭)
 * @param {object} opts  {recipient, quantity}
 * @returns {Promise<object>} {ok, stage, ...진단}
 */
export async function cdpSelectOptionAndBuy(tabId, goodsNo, orderOption, opts = {}) {
  await dbgAttach(tabId);
  try {
    // 0) 탭 렌더 대기(innerHeight>0). 백그라운드/미포커스 탭은 innerHeight=0 이라 좌표 클릭 무효.
    await waitFor(tabId, `window.innerHeight > 100 ? 1 : 0`, { timeout: 10000 }).catch(() => {});
    // 1) 옵션 메타 로드(API) → 주문 옵션과 STRICT 매칭(모호하면 STOP — 오배송 방지).
    const meta = await evaluate(tabId, optionsFetchExpr(goodsNo)).catch((e) => ({ ok: false, err: String(e && e.message || e) }));
    if (!meta || !meta.ok) return { ok: false, stage: 'options_fetch_failed', meta };
    const matched = matchOptionItem(meta.items, orderOption);
    if (!matched.item) {
      return { ok: false, stage: matched.reason === 'ambiguous' ? 'option_ambiguous' : 'option_not_found',
        tokens: parseOptionTokens(orderOption), dims: meta.dims, itemCount: meta.items.length, hitCount: matched.hitCount };
    }
    const optionMatched = { values: matched.item.values, reason: matched.reason };
    // 2) 페이지 준비(구매하기 등장) 후 차원별 값 순차 선택(색상 → 사이즈 등).
    await waitFor(tabId, `(${F_BUY}) ? 1 : 0`, { timeout: 15000 });
    let clickedDims = 0;
    const dimTraces = [];
    for (let i = 0; i < matched.item.values.length; i++) {
      const dim = meta.dims[i] || '';
      const value = matched.item.values[i];
      const allValues = meta.items.map((it) => it.values[i]).filter(Boolean);
      // 주의: 단일 값 차원(색상 BEG 하나뿐)도 PDP 에 드롭다운이 있고 선택해야 다음 차원이 열림(실측).
      const sel = await selectDimValue(tabId, dim, value, allValues).catch((e) => ({ c: null, trace: { dim, value, error: String(e && e.message || e) } }));
      dimTraces.push(sel.trace);
      if (!sel.c) {
        // 단일 아이템 상품(FREE/NONE 등)은 선택 UI 가 없을 수 있음 → 선택 생략하고 구매 시도.
        if (meta.items.length === 1) break;
        const sizeCandidates = await evaluate(tabId, fSizeCandidates(value)).catch(() => null);
        return { ok: false, stage: 'option_row_not_found', optionMatched, dim, value, dimTraces, sizeCandidates };
      }
      clickedDims += 1;
      await sleep(400);
    }
    // 3) 선택 검증(총 N개). 단일 아이템 + 선택 UI 없음이면 통과(구매하기 실패 시 no_order_form 으로 잡힘).
    let selected = 0;
    try { selected = await waitFor(tabId, F_SELECTED, { timeout: 5000 }); } catch (e) { selected = 0; }
    if (!selected && !(meta.items.length === 1 && clickedDims === 0)) {
      const diag = await evaluate(tabId, DIAG_EXPR).catch(() => null);
      return { ok: false, stage: 'option_not_selected', optionMatched, dimTraces, diag };
    }
    // 4) 수량(기본 1). 스테퍼 '+' 를 (수량-1)회 → 입력값 검증(미달 주문 방지 fail-loud).
    const qty = Math.max(1, Math.min(10, Number(opts.quantity) || 1));
    if (qty > 1) {
      for (let i = 1; i < qty; i++) {
        try { await clickElement(tabId, F_QTY_PLUS, '수량 +'); } catch (e) {
          return { ok: false, stage: 'quantity_plus_not_found', optionMatched, want: qty };
        }
        await sleep(250);
      }
      const got = await evaluate(tabId, QTY_VALUE_EXPR).catch(() => null);
      if (Number(got) !== qty) return { ok: false, stage: 'quantity_mismatch', optionMatched, want: qty, got };
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
      for (const cand of candidates.slice(0, 6)) {
        // address2 빈 문자열은 saveAction 이 거부(실측) → '-' 폴백.
        const body = { name, mobile, zipcode, address1: cand.address1, address2: String(cand.address2 || '').trim() || '-', isDefault: true, additionalMessage: '', additionalMessageManual: '' };
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
