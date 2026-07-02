// 목적: 롯데온 소싱 체크아웃 CDP 자동화(주문시작 Tier-2). 무신사 cdp-driver 프리미티브 재사용.
// 흐름: pbf 옵션 API 매칭(STRICT+품절) → 옵션 UI CDP 선택(.selectResult→.selectLists li) →
//   바로 구매하기 → 주문서(/p/order/orderSheet) → 배송지 registerMemberDelivery(고객주소, 기본지정,
//   raw 주소 수용=Daum 불필요) → 주문서 재로드/검증 → 결제 직전 정지. spec: sourcing design(롯데온).
// 배송지 API(실측): POST pbf.lotteon.com/member/v1/delivery/registerMemberDelivery (bseDvpYn:'Y' → 기본지정,
//   strSeq=새 dvpSn 반환, 항상 신규생성). 정리: POST /member/v1/deleteMemberDeliveryList (주소객체 전체).

import { dbgAttach, dbgDetach, evaluate, waitFor, clickAt, clickElement, buildAddressCandidates, normPhone, getTrackedAddrIds, setTrackedAddrIds } from './cdp-driver.js';

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
  // 트리거가 이미 선택 라벨을 보이면 스킵(단일값 등).
  for (let attempt = 0; attempt < 3; attempt++) {
    // 1) 드롭다운 열기.
    await evaluate(tabId, `(function(){var t=${trig};if(t&&t.scrollIntoView)t.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
    await sleep(350);
    await clickElement(tabId, trig, '옵션 트리거 ' + i).catch(() => {});
    await sleep(500);
    // 2) li 등장 대기 → 뷰포트로 스크롤 → 뷰포트 안 좌표 클릭(off-screen 클릭은 미반영).
    let present = false; const t0 = Date.now();
    while (Date.now() - t0 < 4000) { present = !!(await evaluate(tabId, `(${liSel}) ? 1 : 0`).catch(() => 0)); if (present) break; await sleep(300); }
    if (!present) continue;
    await evaluate(tabId, `(function(){var el=${liSel};if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});return 1;})()`).catch(() => {});
    await sleep(300);
    const c = await evaluate(tabId, `(function(){var el=${liSel};if(!el)return null;var r=el.getBoundingClientRect();if(r.top<0||r.bottom>window.innerHeight||r.width<=0)return null;return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null);
    if (!c) continue;
    await clickAt(tabId, c.x, c.y);
    await sleep(600);
    // 3) 반영 검증: 해당 wrap .selectResult 텍스트에 라벨 포함?
    const ok = await evaluate(tabId, `(function(){var w=${wrap};if(!w)return 0;var sr=w.querySelector('.selectResult');`
      + `return sr && (sr.textContent||'').replace(/\\s+/g,'').toUpperCase().indexOf(${JSON.stringify(label)}.replace(/\\s+/g,'').toUpperCase())>=0 ? 1:0;})()`).catch(() => 0);
    if (ok) return true;
  }
  return false;
}

// 롯데온 배송지 등록(고객주소, 기본지정). raw 주소 수용. 후보 사다리+백오프(무신사 대응). 반환 {ok,dvpSn,attempts}
async function registerLotteonAddress(tabId, rc) {
  const name = String(rc.name || '').trim();
  const mobile = normPhone(rc.phone);
  const zipcode = String(rc.zipcode || '').replace(/\D/g, '');
  if (rc.phone && !mobile) return { ok: false, stage: 'invalid_phone', phone: String(rc.phone) };
  if (!name || !mobile || zipcode.length !== 5 || !String(rc.address || '').trim()) {
    return { ok: false, stage: 'recipient_incomplete', missing: { name: !name, mobile: !mobile, zipcode: zipcode.length !== 5, address: !String(rc.address || '').trim() } };
  }
  const mphn = mobile.replace(/\D/g, ''); // 하이픈 없이
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
    // 3) 바로 구매하기 → 주문서(scrollIntoView + 뷰포트 클릭, 재시도).
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
    if (!reached) return { ok: false, stage: 'no_order_form', optionMatched };
    await sleep(2500);
    // 4) 배송지: 고객주소 등록(기본지정) → 정리 → 주문서 재로드 → 수령인 표시 검증.
    if (opts.recipient) {
      const reg = await registerLotteonAddress(tabId, opts.recipient);
      if (!reg.ok) return { ...reg, optionMatched };
      await cleanupLotteonAddresses(tabId, reg.dvpSn).catch(() => {});
      await evaluate(tabId, 'location.reload()').catch(() => {});
      await sleep(2500);
      await waitFor(tabId, `(location.href.indexOf('${ORDER_SHEET_RE}')>=0 && !!document.body) ? 1 : 0`, { timeout: 15000 }).catch(() => {});
      let shown = 0;
      try { shown = await waitFor(tabId, `((document.querySelector('.deliveryWrap')||document.body).textContent||'').indexOf(${JSON.stringify(String(opts.recipient.name || '__none__'))})>=0 ? 1 : 0`, { timeout: 8000 }); } catch (e) { shown = 0; }
      if (!shown) return { ok: false, stage: 'recipient_not_shown', optionMatched, dvpSn: reg.dvpSn, attempts: reg.attempts };
      return { ok: true, stage: 'delivery_set', optionMatched, dvpSn: reg.dvpSn, address1: reg.address1 };
    }
    return { ok: true, stage: 'order_form', optionMatched };
  } catch (e) {
    return { ok: false, stage: 'lotteon_error', error: String(e && e.message || e) };
  } finally {
    await dbgDetach(tabId);
  }
}
