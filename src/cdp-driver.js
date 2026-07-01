// 목적: chrome.debugger(CDP)로 소싱처 체크아웃을 trusted 이벤트로 자동 구동(주문시작 Tier-2).
// 콘텐츠스크립트는 isTrusted:false 라 무신사 Radix 옵션/드로어를 못 여는데, CDP Input.* 은
// 브라우저 레벨 trusted 이벤트(수동 클릭과 동일)라 Radix·크로스오리진 iframe(Daum)까지 구동 가능.
// 현재 구현 범위(1b-1): 옵션(사이즈) 선택 → 구매하기 → 주문서 도달까지(라이브 검증 구간).
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
// 주문서 "배송지 변경" — button 우선(div 래퍼 오클릭 방지), 없으면 a/div.
const F_DELIV_CHANGE = `(function(){var f=function(b){return (b.textContent||'').trim()==='배송지 변경';};`
  + `return [].find.call(document.querySelectorAll('button'),f)||[].find.call(document.querySelectorAll('a,div'),f);})()`;
// 드로어가 떴는지 신호(Drawer 요소 또는 신규/추가/우편번호 버튼 등장).
const F_DRAWER_READY = `(document.querySelector('[class*="Drawer"],[role="dialog"]') || `
  + `[].some.call(document.querySelectorAll('button,a,div,span'),function(b){return /신규|배송지\\s*추가|직접\\s*입력|우편번호/.test((b.textContent||''));})) ? 1 : 0`;
// 배송지 드로어/폼 구조 덤프(진단용): Drawer 존재/클래스 + 전체 버튼텍스트 + 신규/추가/우편번호 요소 + 입력칸.
const DRAWER_DUMP = `(function(){`
  + `var dw=document.querySelector('[class*="Drawer"],[role="dialog"],[class*="Modal"]');`
  + `var btns=[].slice.call(document.querySelectorAll('button,a,[role="button"]')).map(function(b){return (b.textContent||'').trim();}).filter(function(t){return t&&t.length<20;});`
  + `var uniq=btns.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,40);`
  + `var addLike=[].slice.call(document.querySelectorAll('button,a,div,span')).filter(function(e){var t=(e.textContent||'').trim();var r=e.getBoundingClientRect();return t.length<24&&r.width>0&&r.height>0&&/신규|배송지\\s*추가|직접\\s*입력|우편번호|주소\\s*검색/.test(t);}).map(function(e){var r=e.getBoundingClientRect();return {tag:e.tagName,text:(e.textContent||'').trim().slice(0,20),top:Math.round(r.top)};}).slice(0,12);`
  + `var inputs=[].slice.call(document.querySelectorAll('input,textarea')).filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).map(function(e){return {ph:e.placeholder||'',name:e.name||'',ro:!!(e.readOnly||e.hasAttribute('readonly'))};}).slice(0,18);`
  + `return {drawerFound:!!dw, drawerCls:dw?(dw.className||'').toString().slice(0,40):null, buttons:uniq, addLike:addLike, inputs:inputs};})()`;

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
    // 6) 배송지 설정: 소싱슬롯 주소(opts.slotId)를 고객주소로 덮어쓰기(updateAction, Daum 우회) →
    //    주문서 재로드(갱신된 기본배송지 반영) → 결제 직전 정지. (order-service 는 same-origin+쿠키.)
    if (opts.recipient) {
      const r = opts.recipient;
      // 소싱슬롯 주소 id: 미지정 시 비-기본 주소(사용자 기본주소 불가침) 자동 선택.
      let slotId = opts.slotId;
      if (!slotId) {
        slotId = await evaluate(tabId, `(async function(){try{var l=await fetch('https://www.musinsa.com/order-service/my/addresses/getMemberAddresses',{credentials:'include',headers:{'Accept':'application/json'}}).then(function(x){return x.json();});var a=(l&&l.data&&l.data.addresses)||[];var nd=null;for(var i=0;i<a.length;i++){if(!a[i].isDefault){nd=a[i];break;}}nd=nd||a[0];return nd?nd.id:null;}catch(e){return null;}})()`).catch(() => null);
      }
      if (!slotId) { return { ok: false, stage: 'no_sourcing_slot', optionMatched }; }
      const updExpr = `(async function(){`
        + `var base='https://www.musinsa.com/order-service';`
        + `var body={id:${Number(slotId)},name:${JSON.stringify(String(r.name || ''))},mobile:${JSON.stringify(String(r.phone || ''))},zipcode:${JSON.stringify(String(r.zipcode || ''))},address1:${JSON.stringify(String(r.address1 || ''))},address2:${JSON.stringify(String(r.address2 || ''))},isDefault:true,additionalMessage:${JSON.stringify(String(r.message || ''))},additionalMessageManual:'',originReferrer:location.href};`
        + `var res=await fetch(base+'/my/addresses/updateAction',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});`
        + `var j=null;try{j=await res.json();}catch(e){}`
        + `return {status:res.status,result:(j&&(j.result!==undefined?j.result:(j.meta&&j.meta.result)))};})()`;
      let addressUpdate = null;
      try { addressUpdate = await evaluate(tabId, updExpr); } catch (e) { addressUpdate = { error: String(e && e.message || e) }; }
      await evaluate(tabId, 'location.reload()').catch(() => {});
      await sleep(2000);
      await waitFor(tabId, `(location.href.indexOf('/order/order-form')>=0 && !!document.body) ? 1 : 0`, { timeout: 15000 }).catch(() => {});
      await sleep(1200);
      const shown = await evaluate(tabId, `((document.body.innerText||'').indexOf(${JSON.stringify(String(r.name || '__none__'))})>=0) ? 1 : 0`).catch(() => 0);
      return { ok: true, stage: 'delivery_set', optionMatched, addressUpdate, recipientShownOnOrderForm: !!shown };
    }
    return { ok: true, stage: 'order_form', optionMatched };
  } finally {
    await dbgDetach(tabId);
  }
}
