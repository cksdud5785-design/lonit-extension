// 목적: 롯데온 소싱 체크아웃 CDP 자동화(주문시작 Tier-2). 무신사 cdp-driver 프리미티브 재사용.
// 흐름: pbf 옵션 API 매칭(STRICT+품절) → 옵션 UI CDP 선택(.selectResult→.selectLists li) →
//   바로 구매하기 → 주문서(/p/order/orderSheet) → 배송지 registerMemberDelivery(고객주소, 기본지정,
//   raw 주소 수용=Daum 불필요) → 주문서 재로드/검증 → 결제 직전 정지. spec: sourcing design(롯데온).
// 배송지 API(실측): POST pbf.lotteon.com/member/v1/delivery/registerMemberDelivery (bseDvpYn:'Y' → 기본지정,
//   strSeq=새 dvpSn 반환, 항상 신규생성). 정리: POST /member/v1/deleteMemberDeliveryList (주소객체 전체).

import { dbgAttach, dbgDetach, evaluate, waitFor, clickAt, clickElement, buildAddressCandidates, getTrackedAddrIds, setTrackedAddrIds } from './cdp-driver.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PBF = 'https://pbf.lotteon.com';
const ORDER_SHEET_RE = '/p/order/orderSheet';

export function parseLotteonProduct(url) {
  const m = String(url || '').match(/\/p\/product\/([A-Z]{2}\d+)/);
  const mall = (String(url || '').match(/mall_no=(\d+)/) || [])[1] || '1';
  return m ? { pdId: m[1], mallNo: mall } : null;
}

// pbf 옵션 메타 → 차원(title/options[{label,value,disabled}]) + 유효조합 매핑.
function optionsFetchExpr(pdId, mallNo) {
  return `(async function(){try{`
    + `var r=await fetch('${PBF}/product/v2/detail/search/base/pd/${pdId}?mall_no=${Number(mallNo)}',{credentials:'include',headers:{'Accept':'application/json'}});`
    + `var j=await r.json();var d=(j&&j.data)||j;var oi=(d&&d.optionInfo)||{};var list=oi.optionList||[];`
    + `var dims=list.map(function(o){return {title:o.title,values:(o.options||[]).map(function(v){return {label:String(v.label||''),value:String(v.value||''),disabled:!!v.disabled};})};});`
    + `return {ok:true,dims:dims,mapping:oi.optionMappingInfo||null};}catch(e){return {ok:false,err:String(e&&e.message||e)};}})()`;
}

// 옵션 매칭: 롯데온 주문옵션은 "상품명, 색상, 사이즈"처럼 콤마로 구분되고 색상엔 슬래시가 포함될 수
//   있어(예 "Black / White", "배얼리 그린//블랙…") 무신사식 슬래시 토큰분리는 못 씀. → 콤마 세그먼트
//   단위로, 각 차원 라벨을 세그먼트에 정확일치(정규화) 우선, 실패시 세그먼트 포함(최장 유일) 매칭.
const normOpt = (t) => String(t || '').replace(/\s+/g, '').toUpperCase();
function orderSegments(orderOption) {
  const s = String(orderOption || '').replace(/\s*[xX×]\s*\d+\s*$/, '');
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
function matchDimLabel(dim, segs) {
  const nsegs = segs.map(normOpt);
  const vals = dim.values || [];
  // 1) 세그먼트와 정규화 정확일치.
  let hits = vals.filter((v) => nsegs.includes(normOpt(v.label)));
  if (hits.length === 1) return { label: hits[0].label, disabled: hits[0].disabled };
  if (hits.length > 1) return { ambiguous: true };
  // 2) 세그먼트가 라벨을 포함(최장 라벨 우선, S가 XS 오매칭 안 되게) — 유일할 때만.
  const cont = vals.filter((v) => normOpt(v.label) && nsegs.some((s) => s.includes(normOpt(v.label))));
  if (!cont.length) return { none: true };
  cont.sort((a, b) => normOpt(b.label).length - normOpt(a.label).length);
  const maxlen = normOpt(cont[0].label).length;
  const top = cont.filter((v) => normOpt(v.label).length === maxlen);
  return top.length === 1 ? { label: top[0].label, disabled: top[0].disabled } : { ambiguous: true };
}
function buildLotteonMatch(meta, orderOption) {
  const dims = meta.dims || [];
  if (dims.length === 0) return { item: { labels: [], disabled: false }, reason: 'no_option' };
  const segs = orderSegments(orderOption);
  const labels = []; let anyDisabled = false;
  for (let i = 0; i < dims.length; i++) {
    const m = matchDimLabel(dims[i], segs);
    if (m.ambiguous) return { item: null, reason: 'ambiguous', dim: dims[i].title };
    if (m.none || !m.label) return { item: null, reason: 'no_match', dim: dims[i].title };
    labels.push(m.label);
    if (i === dims.length - 1) anyDisabled = !!m.disabled; // 마지막 차원(사이즈)이 재고 기준.
  }
  return { item: { labels, disabled: anyDisabled }, reason: 'segment' };
}

// 차원 i 의 라벨 선택: .optionWrap[i] → .selectResult 클릭(열기) → .selectLists li(접두매칭,품절제외) 클릭.
async function selectLotteonDim(tabId, i, label, allLabels) {
  const wrap = `document.querySelectorAll('.priceOptionWrap .optionWrap, .productOptionContent .optionWrap')[${i}]`;
  const trig = `((${wrap})&&(${wrap}).querySelector('.selectResult'))`;
  const all = JSON.stringify([...new Set(allLabels)].sort((a, b) => b.length - a.length));
  const liSel = `(function(){var w=${wrap};if(!w)return null;var want=${JSON.stringify(label)};var all=${all};`
    + `var norm=function(t){return String(t||'').replace(/\\s+/g,'').toUpperCase();};var lis=w.querySelectorAll('.selectLists li');`
    + `for(var k=0;k<lis.length;k++){var li=lis[k];var t=norm(li.textContent);var m=null;`
    + `for(var x=0;x<all.length;x++){if(t.indexOf(norm(all[x]))===0){m=all[x];break;}}`
    + `if(m===want && !/disabled/.test(li.className) && !/\\[품절\\]/.test(li.textContent||''))return li;}return null;})()`;
  const selectedExpr = `(function(){var w=${wrap};if(!w)return 0;var sr=w.querySelector('.selectResult');`
    + `return sr && (sr.textContent||'').replace(/\\s+/g,'').toUpperCase().indexOf(${JSON.stringify(label)}.replace(/\\s+/g,'').toUpperCase())>=0 ? 1:0;})()`;
  // 트리거/래퍼가 렌더될 때까지 대기(페이지 정착).
  await waitFor(tabId, `(${trig}) ? 1 : 0`, { timeout: 8000 }).catch(() => {});
  // 이미 선택돼 있으면(단일값 자동선택 등) 통과.
  if (await evaluate(tabId, selectedExpr).catch(() => 0)) return true;
  for (let attempt = 0; attempt < 5; attempt++) {
    // 1) 드롭다운 열기: 트리거 클릭 후 li 등장 확인, 안 열리면 트리거 재클릭(어택트당 2회).
    let present = false;
    for (let open = 0; open < 2 && !present; open++) {
      await evaluate(tabId, `(function(){var t=${trig};if(t&&t.scrollIntoView)t.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
      await sleep(300);
      const tc = await evaluate(tabId, `(function(){var t=${trig};if(!t)return null;var r=t.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight||r.width<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
      if (tc) await clickAt(tabId, tc.x, tc.y); else await clickElement(tabId, trig, '옵션 트리거 ' + i).catch(() => {});
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) { present = !!(await evaluate(tabId, `(${liSel}) ? 1 : 0`).catch(() => 0)); if (present) break; await sleep(250); }
    }
    if (!present) { await sleep(400); continue; }
    // 2) li 뷰포트 스크롤 → 뷰포트 안 좌표 클릭(off-screen 좌표클릭은 Vue 미반영).
    await evaluate(tabId, `(function(){var el=${liSel};if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
    await sleep(300);
    const c = await evaluate(tabId, `(function(){var el=${liSel};if(!el)return null;var r=el.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight||r.width<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
    if (!c) { await sleep(300); continue; }
    await clickAt(tabId, c.x, c.y);
    await sleep(600);
    // 3) 반영 검증: 해당 wrap .selectResult 텍스트에 라벨 포함?
    if (await evaluate(tabId, selectedExpr).catch(() => 0)) return true;
  }
  return false;
}

// 롯데온 전화 정규화: 무신사와 달리 롯데온 배송지 API 는 0502/0504 안심번호(마켓 중계번호)를
//   그대로 수용한다(라이브 실증 2026-07-03) — 롯데온 소싱 주문 수령인 전화는 사실상 100% 안심번호라
//   01X-only(normPhone) 로 거르면 전건 실패한다. 숫자만 추출해 9~12자리면 그대로 사용(010/070/0502/0504).
function lotteonPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return (d.length >= 9 && d.length <= 12) ? d : '';
}

// 롯데온 배송지 등록(고객주소, 기본지정). raw 주소 수용. 후보 사다리+백오프(무신사 대응). 반환 {ok,dvpSn,attempts}
async function registerLotteonAddress(tabId, rc) {
  const name = String(rc.name || '').trim();
  const mphn = lotteonPhone(rc.phone); // 안심번호 포함 숫자 그대로(하이픈 없이)
  const zipcode = String(rc.zipcode || '').replace(/\D/g, '');
  if (rc.phone && !mphn) return { ok: false, stage: 'invalid_phone', phone: String(rc.phone) };
  if (!name || !mphn || zipcode.length !== 5 || !String(rc.address || '').trim()) {
    return { ok: false, stage: 'recipient_incomplete', missing: { name: !name, mobile: !mphn, zipcode: zipcode.length !== 5, address: !String(rc.address || '').trim() } };
  }
  const cands = buildAddressCandidates(rc.address, rc.addressDetail).slice(0, 4);
  const attempts = [];
  const regExpr = (a1, a2) => `(async function(){try{`
    + `var body={dvpNm:'소싱',dvRmttNm:${JSON.stringify(name)},mphnNo:${JSON.stringify(mphn)},telNo:'',dvMsgCd:'',dvMsg:'',`
    + `stnmZipNo:${JSON.stringify(zipcode)},stnmZipAddr:${JSON.stringify(a1)},stnmDtlAddr:${JSON.stringify(a2)},`
    + `jbZipNo:${JSON.stringify(zipcode)},jbZipAddr:${JSON.stringify(a1)},jbDtlAddr:${JSON.stringify(a2)},`
    + `bseDvpYn:'Y',baseDvYn:'Y',useYn:'Y',rowStatus:'I'};`
    + `var r=await fetch('${PBF}/member/v1/delivery/registerMemberDelivery',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});`
    + `var j=await r.json();return {status:r.status,result:(j&&j.data&&j.data.result),dvpSn:(j&&j.data&&j.data.strSeq),msg:(j&&j.message)||''};}catch(e){return {result:'ERR',msg:String(e&&e.message||e)};}})()`;
  let saved = null;
  const trySave = async (cand) => {
    const res = await evaluate(tabId, regExpr(cand.address1, String(cand.address2 || '').trim() || '-')).catch((e) => ({ result: 'ERR', msg: String(e) }));
    attempts.push({ address1: cand.address1, result: res && res.result, msg: res && res.msg });
    if (res && res.result === 'SUCCESS' && res.dvpSn) { saved = { dvpSn: String(res.dvpSn), address1: cand.address1 }; return true; }
    return false;
  };
  // 대표 후보 우선(0/4s/9s 쿨다운), 실패시 대체 형식.
  for (const wait of [0, 4000, 9000]) { if (wait) await sleep(wait); if (await trySave(cands[0])) break; }
  if (!saved) { for (let i = 1; i < cands.length; i++) { await sleep(2500); if (await trySave(cands[i])) break; } }
  if (!saved) return { ok: false, stage: 'address_create_failed', attempts };
  return { ok: true, dvpSn: saved.dvpSn, address1: saved.address1, attempts };
}

// 이전 런에서 우리가 만든 배송지 정리(추적 dvpSn 만, 사용자 기존주소 불가침).
async function cleanupLotteonAddresses(tabId, keepDvpSn) {
  const prev = (await getTrackedAddrIds()).filter((id) => String(id) !== String(keepDvpSn));
  if (!prev.length) { await setTrackedAddrIds([keepDvpSn]); return; }
  const remaining = await evaluate(tabId, `(async function(){try{`
    + `var l=await fetch('${PBF}/order/v1/orderSheetVue/getMemberDeliveryPlaceList?_='+Date.now(),{credentials:'include'}).then(function(x){return x.json();});`
    + `var arr=Array.isArray(l.data)?l.data:((l.data&&l.data.list)||[]);var want=${JSON.stringify(prev.map(String))};var out=[];`
    + `for(var i=0;i<arr.length;i++){if(want.indexOf(String(arr[i].dvpSn))>=0){`
    + `try{await fetch('${PBF}/member/v1/deleteMemberDeliveryList',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(arr[i])});}catch(e){out.push(String(arr[i].dvpSn));}}}`
    + `return out;}catch(e){return want;}})()`).catch(() => prev.map(String));
  await setTrackedAddrIds([keepDvpSn, ...(Array.isArray(remaining) ? remaining : [])]);
}

// 주문서 "변경" 모달을 열어 고객 주소(name/dvpSn)를 선택. 셀러가 base 자동선택 안 할 때 사용.
// 반환: 진단용 모달 덤프({radios, buttons, clickedRow, clickedConfirm}).
async function ensureAddressSelected(tabId, name, dvpSn) {
  // 배송지 미선택 시 버튼은 "선택", 선택됨 시 "변경". 배송정보 영역(.deliveryWrap) 내로 한정.
  const changeFinder = `(function(){var scope=document.querySelector('.deliveryWrap')||document;`
    + `return [].find.call(scope.querySelectorAll('.btnAddress,button,a'),function(b){var t=(b.textContent||'').trim();return t==='변경'||t==='선택';})||null;})()`;
  const btnInfo = await evaluate(tabId, `(function(){var b=${changeFinder};if(!b)return {found:false};var r=b.getBoundingClientRect();return {found:true,tag:b.tagName,txt:(b.textContent||'').trim().slice(0,10),y:Math.round(r.top),h:Math.round(r.height)};})()`).catch(() => ({ err: 1 }));
  await evaluate(tabId, `(function(){var b=${changeFinder};if(b&&b.scrollIntoView)b.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
  await sleep(500);
  const cc = await evaluate(tabId, `(function(){var b=${changeFinder};if(!b)return null;var r=b.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight||r.width<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
  if (cc) await clickAt(tabId, cc.x, cc.y); else await clickElement(tabId, changeFinder, '배송지 선택/변경').catch(() => {});
  // 모달 등장 대기.
  await waitFor(tabId, `document.querySelector('.v--modal-box') ? 1 : 0`, { timeout: 6000 }).catch(() => {});
  await sleep(800);
  // 우리 주소 행(name 포함하는 label/li) 클릭 → 확인/적용 버튼 클릭.
  const rowFinder = `(function(){var box=document.querySelector('.v--modal-box');if(!box)return null;`
    + `var rows=box.querySelectorAll('label,li,.deliveryItem,[class*="item"]');`
    + `for(var k=0;k<rows.length;k++){var t=rows[k].textContent||'';if(t.indexOf(${JSON.stringify(name)})>=0){var r=rows[k].getBoundingClientRect();if(r.width>0&&r.height>0)return rows[k];}}return null;})()`;
  const rowState = await evaluate(tabId, `(function(){var el=${rowFinder};if(!el)return null;var r=el.getBoundingClientRect();return {y:Math.round(r.top),h:Math.round(r.height)};})()`).catch(() => null);
  let clickedRow = false;
  if (rowState) {
    await evaluate(tabId, `(function(){var el=${rowFinder};if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
    await sleep(300);
    const rc = await evaluate(tabId, `(function(){var el=${rowFinder};if(!el)return null;var r=el.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight)return null;return {x:Math.round(r.left+30),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
    if (rc) { await clickAt(tabId, rc.x, rc.y); clickedRow = true; await sleep(500); }
  }
  // 확인/적용/선택 버튼(새배송지추가·임직원·취소 제외).
  const confirmFinder = `(function(){var box=document.querySelector('.v--modal-box');if(!box)return null;`
    + `var bs=box.querySelectorAll('button,a');for(var k=0;k<bs.length;k++){var t=(bs[k].textContent||'').replace(/\\s+/g,'');`
    + `if(/^(확인|적용|선택|배송지선택|배송지변경|이배송지로배송)$/.test(t)){var r=bs[k].getBoundingClientRect();if(r.width>0&&r.height>0)return bs[k];}}return null;})()`;
  const dump = await evaluate(tabId, `(function(){var box=document.querySelector('.v--modal-box');if(!box)return {noModal:true};`
    + `var radios=[].map.call(box.querySelectorAll('label,li'),function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40);}).filter(Boolean).slice(0,12);`
    + `var buttons=[].map.call(box.querySelectorAll('button,a'),function(e){return (e.textContent||'').trim();}).filter(Boolean).slice(0,14);`
    + `return {radios:radios, buttons:buttons};})()`).catch(() => null);
  let clickedConfirm = false;
  const confState = await evaluate(tabId, `(function(){var el=${confirmFinder};if(!el)return null;var r=el.getBoundingClientRect();return {t:(el.textContent||'').trim(),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
  if (confState && confState.y >= 0 && confState.y <= 900) { await clickAt(tabId, confState.x, confState.y); clickedConfirm = true; await sleep(1500); }
  return { btnInfo, clickCoord: cc, clickedRow, clickedConfirm, confirmBtn: confState && confState.t, dump };
}

/**
 * 롯데온: 옵션 선택 → 바로구매 → 주문서 → 배송지(고객주소 기본지정) → 결제 직전 정지.
 * @param {number} tabId  PDP 탭(이미 열림)
 * @param {string} url  PDP URL
 * @param {string} orderOption  주문 옵션 원문
 * @param {object} opts  {recipient}
 */
export async function cdpLotteonOptionAndBuy(tabId, url, orderOption, opts = {}) {
  await dbgAttach(tabId);
  try {
    await waitFor(tabId, `window.innerHeight > 100 ? 1 : 0`, { timeout: 10000 }).catch(() => {});
    const pd = parseLotteonProduct(url) || parseLotteonProduct(await evaluate(tabId, 'location.href').catch(() => ''));
    if (!pd) return { ok: false, stage: 'bad_url' };
    // 1) 옵션 메타 + STRICT 매칭.
    const meta = await evaluate(tabId, optionsFetchExpr(pd.pdId, pd.mallNo)).catch((e) => ({ ok: false, err: String(e) }));
    if (!meta || !meta.ok) return { ok: false, stage: 'options_fetch_failed', meta };
    const matched = buildLotteonMatch(meta, orderOption);
    if (!matched.item) return { ok: false, stage: matched.reason === 'ambiguous' ? 'option_ambiguous' : 'option_not_found', reason: matched.reason };
    if (matched.item.disabled) return { ok: false, stage: 'soldout', labels: matched.item.labels };
    const optionMatched = { labels: matched.item.labels };
    // 2) 페이지 준비 후 차원별 선택.
    await waitFor(tabId, `[].some.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').replace(/\\s+/g,'').indexOf('바로구매')===0;}) ? 1 : 0`, { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < matched.item.labels.length; i++) {
      const allLabels = (meta.dims[i].values || []).map((v) => v.label);
      const ok = await selectLotteonDim(tabId, i, matched.item.labels[i], allLabels).catch(() => false);
      if (!ok) return { ok: false, stage: 'option_select_failed', dimIndex: i, label: matched.item.labels[i], optionMatched };
    }
    // 3) 배송지 선등록: 바로구매 전에 고객주소를 기본배송지로 등록 → 주문서가 처음부터 고객주소로 로드
    //    (auto-select 셀러). registerMemberDelivery SUCCESS 를 신뢰하고 진행 — base 즉시조회는 전파
    //    지연으로 거짓음성(address_not_base)이 나 주문페이지 진입을 막았으므로 게이트 제거, 전파만 대기.
    let regInfo = null;
    if (opts.recipient) {
      const reg = await registerLotteonAddress(tabId, opts.recipient);
      if (!reg.ok) return { ...reg, optionMatched };
      await cleanupLotteonAddresses(tabId, reg.dvpSn).catch(() => {});
      await sleep(1000); // base 전파 대기(주문서가 새 base 로 로드되도록)
      regInfo = reg;
    }
    // 4) 바로 구매하기 → 주문서(scrollIntoView + 뷰포트 클릭, 재시도).
    const buyFinder = `(function(){var bs=[].filter.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').replace(/\\s+/g,'').indexOf('바로구매')===0;});`
      + `var vh=window.innerHeight;var iv=bs.filter(function(b){var r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=vh;});return (iv[0]||bs[0])||null;})()`;
    let reached = false;
    for (let k = 0; k < 3 && !reached; k++) {
      await evaluate(tabId, `(function(){var b=${buyFinder};if(b&&b.scrollIntoView)b.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
      await sleep(500);
      const bc = await evaluate(tabId, `(function(){var b=${buyFinder};if(!b)return null;var r=b.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight||r.width<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
      if (bc) await clickAt(tabId, bc.x, bc.y); else await clickElement(tabId, buyFinder, '바로구매').catch(() => {});
      try { await waitFor(tabId, `location.href.indexOf('${ORDER_SHEET_RE}')>=0 ? 1 : 0`, { timeout: 9000 }); reached = true; } catch (e) { await sleep(600); }
    }
    if (!reached) return { ok: false, stage: 'no_order_form', optionMatched, dvpSn: regInfo && regInfo.dvpSn };
    await sleep(2500);
    // 5) 주문서에서 고객 배송지 선택 확인. 셀러에 따라 base 자동표시 안 되고 "배송지를 선택해 주세요"만
    //    뜨는 경우가 있어, 미표시 시 "변경" 모달을 열어 우리 주소를 선택한다.
    if (regInfo) {
      const nm = String(opts.recipient.name || '__none__');
      const shownExpr = `((document.querySelector('.deliveryWrap')||{}).textContent||'').indexOf(${JSON.stringify(nm)})>=0 ? 1 : 0`;
      let shown = await waitFor(tabId, shownExpr, { timeout: 6000 }).catch(() => 0);
      let modalDump = null;
      if (!shown) {
        modalDump = await ensureAddressSelected(tabId, nm, regInfo.dvpSn).catch((e) => ({ err: String(e) }));
        shown = await waitFor(tabId, shownExpr, { timeout: 6000 }).catch(() => 0);
      }
      const deliveryText = await evaluate(tabId, `(function(){var d=document.querySelector('.deliveryWrap');return d?(d.textContent||'').replace(/\\s+/g,' ').trim().slice(0,140):null;})()`).catch(() => null);
      return { ok: true, stage: 'delivery_set', optionMatched, dvpSn: regInfo.dvpSn, address1: regInfo.address1, recipientShown: !!shown, deliveryText, modalDump };
    }
    return { ok: true, stage: 'order_form', optionMatched };
  } catch (e) {
    return { ok: false, stage: 'lotteon_error', error: String(e && e.message || e) };
  } finally {
    await dbgDetach(tabId);
  }
}
