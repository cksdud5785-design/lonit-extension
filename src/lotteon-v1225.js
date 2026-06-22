// 목적: 롯데온 수집 엔진 — fetch API 방식 (검색 qapi + 상세 pbf API)
// 검색: https://www.lotteon.com/csearch/search/search?render=qapi&...
// 상세: https://pbf.lotteon.com/product/v2/detail/search/base/pd/{pdId}?mall_no=1
// 인증 불필요, 60개/페이지

const PAGE_SIZE = 60;
const SEARCH_URL = 'https://www.lotteon.com/csearch/search/search';
const DETAIL_URL = 'https://pbf.lotteon.com/product/v2/detail/search/base/pd';
const IMG_BASE = 'https://contents.lotteon.com';
const DETAIL_DELAY = 200; // 상세 API 호출 간 딜레이 (ms)
const DETAIL_CONCURRENCY = 3; // 동시 상세 조회 수
const ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS = 6;
const KOREA_DELIVERY_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-03-02',
  '2026-05-01',
  '2026-05-05',
  '2026-05-25',
  '2026-06-03',
  '2026-06-06',
  '2026-08-15',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-10-03',
  '2026-10-05',
  '2026-10-09',
  '2026-12-25',
]);

function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isKoreaDeliveryBusinessDay(date) {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && !KOREA_DELIVERY_HOLIDAYS.has(formatLocalDateKey(date));
}

export function businessDaysUntilMonthDay(mm, dd, now = new Date()) {
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(today.getFullYear(), mm - 1, dd);
  if (target.getTime() < today.getTime() - 86400000) target.setFullYear(today.getFullYear() + 1);
  if (target.getTime() <= today.getTime()) return 0;

  let count = 0;
  let loops = 0;
  for (let cursor = new Date(today.getTime() + 86400000); cursor <= target && loops < 60; cursor = new Date(cursor.getTime() + 86400000), loops++) {
    if (isKoreaDeliveryBusinessDay(cursor)) count++;
  }
  return count;
}

export function arrivalBusinessDaysToOutboundLeadDays(arrivalBusinessDays) {
  const n = Math.floor(Number(arrivalBusinessDays));
  if (!Number.isFinite(n) || n < 0 || n > 30 + ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS) return null;
  return Math.max(1, Math.min(30, n - ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS));
}

function isArrivalLeadLabel(label = '') {
  return /도착|배송/.test(label) && !/출고|발송/.test(label);
}

export function normalizeSourceLeadDays(days, label = '') {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  const clamped = Math.max(1, n);
  return isArrivalLeadLabel(label) ? arrivalBusinessDaysToOutboundLeadDays(clamped) : clamped;
}

export function computeLotteonSourceLeadDays(dataRoot = {}, basicInfo = {}, dlvInfo = {}, now = new Date()) {
  if (basicInfo?.thdyPdYn === 'Y') return 1;

  const selectedArrival = Array.isArray(dlvInfo?.arvBgtDtInfoList)
    ? dlvInfo.arvBgtDtInfoList.find((v) => v?.selected === true)
    : null;

  const selectedArrivalDt = String(selectedArrival?.dt || '');
  if (/^\d{8}$/.test(selectedArrivalDt)) {
    const mm = parseInt(selectedArrivalDt.slice(4, 6), 10);
    const dd = parseInt(selectedArrivalDt.slice(6, 8), 10);
    const days = businessDaysUntilMonthDay(mm, dd, now);
    const normalized = normalizeSourceLeadDays(days, selectedArrival?.dvExpectInfoTxt || '도착');
    if (normalized != null) return normalized;
  }

  const deliveryTexts = [
    selectedArrival?.dvExpectInfoTxt,
    dlvInfo?.epctArrDtTxt,
    dlvInfo?.arvBgtDtDlvTermTxt,
    dlvInfo?.todayArvTxt,
    ...(Array.isArray(dlvInfo?.dvList) ? dlvInfo.dvList.map((v) => v?.dayTxt) : []),
    ...(Array.isArray(dlvInfo?.dvList2) ? dlvInfo.dvList2.map((v) => v?.dayTxt) : []),
  ];
  for (const value of deliveryTexts) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const absDate = value.match(/(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(도착(?:확률|예정)?|배송|발송|출고)?/);
    if (absDate) {
      const mm = parseInt(absDate[1], 10);
      const dd = parseInt(absDate[2], 10);
      const days = businessDaysUntilMonthDay(mm, dd, now);
      const normalized = normalizeSourceLeadDays(days, absDate[3] || value);
      if (normalized != null) return normalized;
    }
    if (/내일/.test(value)) return 1;
    if (/모레\s*(?:도착|배송)/.test(value)) return 1;
    if (/모레/.test(value)) return 2;
  }

  const selectedArrivalDay = Number(selectedArrival?.day);
  if (Number.isFinite(selectedArrivalDay) && selectedArrivalDay >= 1 && selectedArrivalDay <= 30) {
    const n = arrivalBusinessDaysToOutboundLeadDays(selectedArrivalDay);
    if (n != null) return n;
  }

  const candidates = [
    dlvInfo?.expcShpmtDays,
    dlvInfo?.avgShpmtDays,
    dlvInfo?.dlvTrmDays,
    dlvInfo?.deliveryDays,
    dlvInfo?.shipmentDays,
    dlvInfo?.sndBgtNday,
    dlvInfo?.leadTime,
  ];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : parseInt(c, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  }

  let fullJson = '';
  try { fullJson = JSON.stringify(dataRoot); } catch { fullJson = ''; }
  if (!fullJson) return null;

  const intMatch = fullJson.match(/평균\s*출고\s*(\d{1,2})\s*일|지금\s*주문\s*시\s*(\d{1,2})\s*일|주문\s*후\s*(\d{1,2})\s*일/);
  if (intMatch) {
    const n = parseInt(intMatch[1] || intMatch[2] || intMatch[3], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  }
  if (/내일(?:[(（][^)）]+[)）])?\s*도착/.test(fullJson)) return 1;
  if (/모레(?:[(（][^)）]+[)）])?\s*도착/.test(fullJson)) return 1;
  const absDate = fullJson.match(/(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(도착(?:확률|예정)?|배송|발송|출고)/);
  if (absDate) {
    const mm = parseInt(absDate[1], 10);
    const dd = parseInt(absDate[2], 10);
    const days = businessDaysUntilMonthDay(mm, dd, now);
    const normalized = normalizeSourceLeadDays(days, absDate[3]);
    if (normalized != null) return normalized;
  }
  return null;
}

// ─── API 헬퍼 ─────────────────────────────────────────────────────────────────

// mallId → collection_id 매핑 (롯데온 qapi는 mallId별 다른 collection_id 사용)
const MALL_COLLECTION_MAP = {
  '2': '201',  // 롯데백화점
};

/** collection_id=201(백화점) 응답 → collection_id=9 형식으로 정규화 */
function normalizeSearchItem(item) {
  // collection_id=9 형식이면 그대로 반환
  if (item.pdId) return item;

  // collection_id=201 → 9 매핑
  const priceArr = Array.isArray(item.priceInfo) ? item.priceInfo : [];
  const getPrice = (type) => {
    const p = priceArr.find(x => x.type === type);
    return p ? String(p.num) : '';
  };

  return {
    ...item,
    pdId: item.productId,
    pdName: item.productName || '',
    pdImage: item.productImage?.replace('https://contents.lotteon.com', '') || '',
    pdLink: item.productLink?.replace('https://www.lotteon.com', '') || '',
    sitmId: item.data?.sitm_no || item.key || '',
    itmId: item.data?.itm_no || '',
    spdId: item.data?.spd_no || '',
    mallNo: item.data?.mall_no || (item.productLink?.match(/mall_no=(\d+)/)?.[1]) || '',
    soldOutYn: item.data?.sout === 'y' ? 'Y' : 'N',
    priceInfo: {
      original: getPrice('original'),
      discount: getPrice('discount'),
      finalPrice: getPrice('final'),
      dcAplyTotAmt: '',
    },
    categoryInfo: item.brazeData?.categoryNo ? { pdStdCategoryId: item.brazeData.categoryNo } : {},
  };
}

/**
 * 검색 API URL 생성.
 * @param {string} keyword
 * @param {number} startIndex
 * @param {number} pageSize
 * @param {{ mallId?: string, sort?: string }} extraParams
 *   sort: 'ranking.desc' (기본) | 'price.asc' | 'price.desc' |
 *         'new.desc' | 'review.desc' | 'sale.desc' ...
 */
function buildSearchUrl(keyword, startIndex = 0, pageSize = PAGE_SIZE, extraParams = {}) {
  const mallId = extraParams.mallId ? String(extraParams.mallId) : '';
  const collectionId = MALL_COLLECTION_MAP[mallId] || '9';
  const sort = extraParams.sort || 'ranking.desc';
  const params = {
    render: 'qapi',
    platform: 'pc',
    collection_id: collectionId,
    q: keyword,
    u2: String(startIndex),
    u3: String(pageSize),
    u16: sort,
    u37: 'true',
  };
  if (mallId) params.mallId = mallId;
  const qs = new URLSearchParams(params);
  return `${SEARCH_URL}?${qs}`;
}

/**
 * 롯데온 검색 API 는 한 정렬 기준으로 최대 35 page × 60개 = 2,100 개만 반환.
 * 전체 상품 수집 위해 여러 정렬 방향으로 돌린 후 pdId 기준 dedup.
 * 실측 ≈6~10k 고유 상품 수집 가능.
 */
const SORT_PASSES = Object.freeze([
  'ranking.desc',
  'price.asc',
  'price.desc',
  'new.desc',
  'review.desc',
]);
const MAX_PAGES_PER_PASS = 35;

/** fetch + JSON 파싱 + 재시도 */
async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) {
        if (res.status === 429 && i < retries) {
          console.warn(`[롯데온] 429 rate limit, ${3 + i * 2}초 대기...`);
          await new Promise(r => setTimeout(r, (3 + i * 2) * 1000));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error(`HTML 응답 수신 (content-type: ${contentType})`);
      }
      return await res.json();
    } catch (err) {
      if (i >= retries) throw err;
      console.warn(`[롯데온] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ─── specs 파싱 헬퍼 ──────────────────────────────────────────────────────────

/**
 * productNotices 배열에서 소재/색상/핏/계절 specs 추출
 * 쿠팡 SEO에 필요한 핵심 속성을 파싱한다.
 * @param {Array<{key: string, value: string}>} notices
 * @returns {Record<string, string>}
 */
function extractSpecsFromNotices(notices) {
  if (!notices || notices.length === 0) return {};
  const specs = {};
  const SPEC_KEYS = {
    '소재': ['소재', '재질', '원단', '원재료', '혼용율', '구성', '성분'],
    '색상': ['색상', '컬러', 'color', '색'],
    '핏': ['핏', '실루엣', '핏감', 'fit'],
    '계절': ['계절', '시즌', '출시시즌', '적합계절'],
  };
  for (const notice of notices) {
    const key = (notice.key || '').toLowerCase().trim();
    const val = (notice.value || '').trim();
    if (!val || val === '-' || val === '해당없음' || val === '상세페이지 참조') continue;
    for (const [specKey, aliases] of Object.entries(SPEC_KEYS)) {
      if (specs[specKey]) continue; // 이미 채워진 경우 스킵
      if (aliases.some(alias => key.includes(alias.toLowerCase()))) {
        specs[specKey] = val.length > 50 ? val.slice(0, 50) : val;
        break;
      }
    }
  }
  return specs;
}

// ─── 혜택가 ───────────────────────────────────────────────────────────────────

// 목적: 롯데ON 혜택가 조회 — Content Script로 실제 DOM 파싱 (로그인 상태 반영)
// promotion API는 비로그인 혜택가만 반환 → DOM의 .advantageBox__top--price .num이 정확한 "나의 혜택가"
// orderDcAplyTotAmt = 카드즉시할인 포함 최적 혜택가 (DOM 값과 일치)
// Content Script(탭) 불필요 — API만으로 정확한 혜택가 획득 가능
async function fetchBenefitPrice(pdId, mallNo = 1) {
  try {
    await new Promise(r => setTimeout(r, 300));
    return await fetchBenefitViaAPI(pdId, mallNo);
  } catch (e) {
    console.warn('[롯데온] 혜택가 조회 실패:', e.message);
    return { benefitPrice: null, benefitDetails: [] };
  }
}

// 탭 재사용 풀 (매번 생성/삭제 안 함)
let _lotteonTabId = null;

// 탭 로드 완료 대기 (onUpdated 이벤트)
function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // CSR 추가 렌더링 대기
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Content Script 방식 — 탭 재사용 + onUpdated 로드 감지
async function fetchBenefitViaTab(pdId, mallNo) {
  const url = `https://www.lotteon.com/p/product/${pdId}?mall_no=${mallNo}`;

  // 탭 재사용 or 생성
  if (_lotteonTabId) {
    try {
      await chrome.tabs.get(_lotteonTabId); // 존재 확인
      await chrome.tabs.update(_lotteonTabId, { url });
    } catch {
      const tab = await chrome.tabs.create({ url, active: false });
      _lotteonTabId = tab.id;
    }
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    _lotteonTabId = tab.id;
  }

  // onUpdated로 로드 완료 감지 (고정 3초 → 실제 로드 완료 + 1.5초)
  await waitForTabLoad(_lotteonTabId);

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: _lotteonTabId },
      func: () => {
        const numEl = document.querySelector('.advantageBox__top--price .num');
        const benefitPrice = numEl ? parseInt(numEl.textContent.replace(/,/g, '')) : null;

        const details = [];
        document.querySelectorAll('.advantageBox__list li').forEach(li => {
          const name = li.querySelector('.name');
          const price = li.querySelector('.price');
          if (name && price) {
            const amt = parseInt(price.textContent.replace(/[^0-9]/g, ''));
            details.push({ type: name.textContent.trim(), amount: amt || 0 });
          }
        });

        return { benefitPrice, benefitDetails: details };
      },
    });

    return result.result || { benefitPrice: null, benefitDetails: [] };
  } catch (e) {
    console.warn('[롯데온] executeScript 실패:', e.message);
    _lotteonTabId = null;
    return null;
  }
}

// 수집 완료 후 탭 정리
export function cleanupLotteonTab() {
  if (_lotteonTabId) { chrome.tabs.remove(_lotteonTabId).catch(() => {}); _lotteonTabId = null; }
}

// Promotion API — orderDcAplyTotAmt 필드에서 카드즉시할인 포함 최적 혜택가 획득
// (DOM의 "나의 혜택가"와 동일, 로그인 없이도 정확)
// 로그인 시 mbFvrOffrAmt에 회원 쿠폰 혜택 추가 가능 (추후 확인)
async function fetchBenefitViaAPI(pdId, mallNo) {
  const baseResp = await fetchJson(
    `${DETAIL_URL}/${pdId}?mall_no=${mallNo}&isNotContainOptMapping=true`
  );
  const d = baseResp.data;
  if (!d) return { benefitPrice: null, benefitDetails: [] };

  const bi = d.basicInfo || {};
  const pi = d.priceInfo || {};
  const di = d.dlvInfo || {};
  const si = d.stckInfo || {};

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const aplyStdDttm = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const params = {
    spdNo: bi.spdNo, sitmNo: bi.sitmNo,
    trGrpCd: bi.trGrpCd, trNo: bi.trNo,
    lrtrNo: bi.lrtrNo || '', strCd: bi.strCd || null,
    ctrtTypCd: bi.ctrtTypCd,
    slPrc: pi.slPrc, slQty: 1,
    scatNo: bi.scatNo || '', brdNo: bi.brdNo || '',
    sfcoPdMrgnRt: pi.sfcoPdMrgnRt ?? null,
    sfcoPdLwstMrgnRt: pi.sfcoPdLwstMrgnRt ?? null,
    afflPdMrgnRt: pi.afflMrgnRt ?? null,
    afflPdLwstMrgnRt: pi.afflLwstMrgnRt ?? null,
    pcsLwstMrgnRt: pi.pcsLwstMrgnRt ?? null,
    infwMdiaCd: 'PC', chCsfCd: 'DI', chTypCd: 'DI02', chNo: '100195', chDtlNo: '1000617',
    aplyStdDttm,
    cartDvsCd: di.cartDvsCd || '01',
    thdyPdYn: bi.thdyPdYn || 'N',
    dvCst: di.dvCst || 0,
    fprdDvPdYn: di.fprdDvPsbYn || 'N',
    discountApplyProductList: pi.discountApplyProductList || [],
    maxPurQty: bi.maxPurQty ?? 1000000,
    stkMgtYn: si?.stkMgtYn || null,
    screenType: 'PRODUCT',
    dmstOvsDvDvsCd: bi.dmstOvsDvDvsCd || 'DMST',
    dvPdTypCd: di.dvPdTypCd || 'GNRL',
    dvCstStdQty: di.dvCstStdQty || 0,
    aplyBestPrcChk: pi.aplyBestPrcChk || 'Y',
    pyMnsExcpLst: bi.pyMnsExcpLst || [],
    mallNo: String(mallNo),
    cpnBoxVersion: 'V2',
  };

  const promoResp = await fetch(
    'https://pbf.lotteon.com/product/v2/extlmsa/promotion/qtyChangeFavorInfoList',
    { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
  );
  const promoData = await promoResp.json();

  if (promoData.returnCode !== '200' || !promoData.data) {
    return { benefitPrice: null, benefitDetails: [] };
  }

  const pd = promoData.data;

  // immdDcAplyTotAmt = 카드 제외 즉시할인가 (스토어할인만 적용)
  // orderDcAplyTotAmt = 카드즉시할인 포함 최적혜택가 (카카오페이/롯데카드/삼성카드 등)
  // benefitPrice = 카드 제외 기본 혜택가 (myBenefit 설정용)
  // cardBenefitPrice = 카드 포함 혜택가 (cardKakao 설정용)
  const benefitPrice = pd.immdDcAplyTotAmt || pd.orderDcAplyTotAmt || null;
  const cardBenefitPrice = pd.orderDcAplyTotAmt || null;

  // 혜택 상세: discountApplyProductList + 표시명
  const benefitDetails = (pd.discountApplyProductList || []).map(dc => ({
    type: dc.fvrNm || dc.prKndNm || dc.prKndCd,
    rate: dc.dcRt ? dc.dcRt + '%' : null,
    amount: dc.dcAmt || 0,
    prKndCd: dc.prKndCd,
  }));

  // 카드즉시할인 표시명 추가 (orderDcAplyDispNm)
  if (pd.orderDcAplyDispNm) {
    const cardDc = benefitDetails.find(dc => dc.prKndCd === 'CRD_IMMD');
    if (cardDc) cardDc.dispNm = pd.orderDcAplyDispNm;
  }

  return { benefitPrice, cardBenefitPrice, benefitDetails };
}

// ─── 상세 API ─────────────────────────────────────────────────────────────────

/** 상품 상세 조회 → 옵션 + 이미지 + 브랜드 보강 */
async function fetchDetail(pdId, mallNo = 1) {
  try {
    console.log(`[BulkFlow 롯데온] 상세 조회: ${pdId} (mall_no=${mallNo})`);
    const data = await fetchJson(`${DETAIL_URL}/${pdId}?mall_no=${mallNo}`);
    const d = data?.data;
    if (!d) { console.warn(`[BulkFlow 롯데온] 상세 data=null: ${pdId}`); return null; }

    const bi = d.basicInfo || {};
    const oi = d.optionInfo || {};
    const ii = d.imgInfo || {};
    const pi = d.priceInfo || {};
    const dlvInfo = d.dlvInfo || {};

    // 옵션 파싱
    // 옵션 파싱 — 계층 구조 (대옵션 > 소옵션)
    // optionList: [{title:"모델명", options:[...]}, {title:"사이즈", options:[...]}]
    // optionMappingInfo: {"value1_value2": {stkQty, sitmNoSlStatCd}} (조합별 재고)
    const options = [];
    const optList = oi.optionList || [];
    const mapping = oi.optionMappingInfo || {};

    if (optList.length === 1) {
      // 단일 옵션 그룹 (사이즈만 등) → flat
      const group = optList[0];
      const optType = group.title || 'option';
      for (const opt of (group.options || [])) {
        const mappingKey = opt.value || '';
        const mapInfo = mapping[mappingKey];
        options.push({
          optionName: opt.label || '',
          optionType: optType,
          optionGroupIndex: 0,
          parentId: null,
          sku: opt.value || '',
          stock: mapInfo ? Math.min(mapInfo.stkQty, 10) : (opt.disabled ? 0 : 10),
          isSoldout: mapInfo ? (mapInfo.sitmNoSlStatCd === 'SOUT') : !!opt.disabled,
          priceDiff: 0,
        });
      }
    } else if (optList.length >= 2) {
      // 다중 옵션 그룹 (대옵션 + 소옵션) → 계층 구조
      // 첫 번째 그룹 = 대옵션, 두 번째 그룹 = 소옵션
      const parentGroup = optList[0];
      const childGroup = optList[1];
      const parentType = parentGroup.title || 'option1';
      const childType = childGroup.title || 'option2';

      // 대옵션별로 자식 옵션을 매핑
      let parentIndex = 0;
      for (const parentOpt of (parentGroup.options || [])) {
        const parentSku = parentOpt.value || '';
        // 대옵션 항목 추가
        options.push({
          optionName: parentOpt.label || '',
          optionType: parentType,
          optionGroupIndex: 0,
          parentId: null, // 대옵션
          sku: parentSku,
          stock: 0, // 자식 합계로 계산됨
          isSoldout: !!parentOpt.disabled,
          priceDiff: 0,
          _parentIndex: parentIndex, // 내부 참조용 (서버 전송 시 제거)
        });

        // 소옵션 (이 대옵션 아래)
        for (const childOpt of (childGroup.options || [])) {
          const childSku = childOpt.value || '';
          const comboKey = `${parentSku}_${childSku}`;
          const mapInfo = mapping[comboKey];
          // 조합 매핑이 있으면 실제 재고/품절 사용
          if (mapInfo || !Object.keys(mapping).length) {
            options.push({
              optionName: childOpt.label || '',
              optionType: childType,
              optionGroupIndex: 1,
              parentId: null, // 서버에서 대옵션 ID로 매핑
              _parentIndex: parentIndex, // 대옵션 인덱스 참조
              sku: comboKey,
              stock: mapInfo ? mapInfo.stkQty : (childOpt.disabled ? 0 : 1),
              isSoldout: mapInfo ? (mapInfo.sitmNoSlStatCd === 'SOUT') : !!childOpt.disabled,
              priceDiff: 0,
            });
          }
        }
        parentIndex++;
      }
    }

    // 이미지 (상세 페이지 이미지 → 고화질)
    // 우선순위: origImgFileNm(S3 직접 URL) > IMG_BASE + imgRteNm + imgFileNm
    // ※ imgUrl / img.url 필드는 실제 API 응답에 존재하지 않음 (버그 수정)
    const images = [];
    const imgList = ii.imageList || ii.imgList || [];
    if (imgList.length > 0) {
      for (const img of imgList) {
        let src = '';
        if (img.origImgFileNm && img.origImgFileNm.startsWith('http')) {
          // S3 원본 URL 사용 (외부 판매자 상품 등)
          src = img.origImgFileNm;
        } else if (img.imgRteNm && img.imgFileNm) {
          // 롯데온 CDN: IMG_BASE + imgRteNm + imgFileNm
          src = `${IMG_BASE}${img.imgRteNm}${img.imgFileNm}`;
        } else if (img.imgUrl || img.url) {
          // 혹시 다른 형태의 응답이 있을 경우 fallback
          const raw = img.imgUrl || img.url;
          src = raw.startsWith('http') ? raw : `${IMG_BASE}${raw}`;
        }
        if (src) images.push(src);
      }
    }

    // 상품 정보고시 (artlInfo.pdItmsArtlJsn)
    const artl = d.artlInfo || {};
    const productNotices = (artl.pdItmsArtlJsn || []).map(a => ({
      key: a.pdArtlCdNm || a.pdArtlCd,
      value: a.pdArtlCnts || '',
    }));

    // specs 파싱: 상품 정보고시에서 소재/색상/핏/계절 등 추출
    const specs = {};
    const SPEC_KEYS = ['소재', '재질', '혼용률', '색상', '사이즈', '핏', '계절', '시즌', '제조국', '원산지', '제조자', '제조사', '품번', '모델번호', '성별'];
    for (const notice of productNotices) {
      const key = (notice.key || '').trim();
      const val = (notice.value || '').trim();
      if (!key || !val || val === '상세페이지 참조' || val === '상세설명참조' || val === '해당없음') continue;
      // 직접 매칭 또는 부분 매칭
      const matchedKey = SPEC_KEYS.find(sk => key.includes(sk));
      if (matchedKey) {
        // 정규화된 키로 저장 (재질→소재, 원산지→제조국, 시즌→계절)
        const normalized = key.includes('재질') ? '소재' : key.includes('원산지') ? '제조국' : key.includes('시즌') ? '계절' : matchedKey;
        if (!specs[normalized]) specs[normalized] = val;
      }
    }

    return {
      brand: bi.brdNm || '',
      categorySource: bi.scatNo || '',
      pdName: bi.pdNm || bi.itmNm || '',
      spdNo: bi.spdNo || '',
      options: options.length > 0 ? options : null,
      images: images.length > 0 ? images : null,
      specs,
      totalStock: options.length > 0
        ? options.filter(o => !o.isSoldout).length
        : (bi.sitmSlStatCd === '20' || bi.sitmSlStatCd === 'SOUT' ? 0 : 10),
      isSoldout: bi.sitmSlStatCd === '20' || bi.sitmSlStatCd === 'SOUT' || (options.length > 0 && options.every(o => o.isSoldout)),
      productNotices: productNotices.length > 0 ? productNotices : null,
      detailImages: images.length > 1 ? images.slice(1) : [], // 첫 번째=대표, 나머지=상세
      // 배송비
      shippingFee: dlvInfo?.dvCst ?? dlvInfo?.dvCstPolLst?.[0]?.dvCst ?? 0,
      shippingType: (dlvInfo?.dvCst === 0 || dlvInfo?.dvCst == null) ? 'free' : 'paid',
      // 소싱처 배송 소요일 (Phase 2 + v1.2.1 → v1.2.2 확장).
      // 1차: basicInfo.thdyPdYn === 'Y' → 당일상품 (1일)
      // 2차: dlvInfo 내 정수 필드 후보 샘플링
      // 3차: API 응답 전체 JSON 을 문자열화해서 "M/D 도착확률|도착예정|이내 도착" 절대날짜 패턴 스캔
      //      (실제 필드 경로 불명확 — 5,888건 전수 NULL 로 확인됨. "4/25 도착확률" 은 사용자 스크린샷에서
      //       분명히 존재하므로 원본 JSON 어딘가에는 있음. 전체 스캔이 가장 견고한 접근.)
      sourceLeadDays: computeLotteonSourceLeadDays(d, bi, dlvInfo),
    };
  } catch (err) {
    console.warn(`[롯데온] 상세 조회 실패 ${pdId}:`, err.message);
    return null;
  }
}

/** 배치 상세 조회 (동시성 제한) */
async function fetchDetailsBatch(items, onDetailProgress) {
  const results = new Map();
  let completed = 0;

  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    const promises = batch.map(async (item) => {
      const detail = await fetchDetail(item.pdId, item.mallNo || item._mallId || 1);
      results.set(item.pdId, detail);
      completed++;
      if (onDetailProgress) onDetailProgress(completed, items.length);
    });
    await Promise.allSettled(promises);
    if (i + DETAIL_CONCURRENCY < items.length) {
      await new Promise(r => setTimeout(r, DETAIL_DELAY));
    }
  }

  return results;
}

// ─── 파싱 ─────────────────────────────────────────────────────────────────────

/** 검색 API + 상세 API + 혜택가 결과 → 상품 변환 */
function parseItem(searchItem, detail, benefit = null) {
  const price = searchItem.priceInfo || {};
  const review = searchItem.reviewInfo || {};
  const cat = searchItem.categoryInfo || {};
  const delivery = searchItem.deliveryInfo || {};

  const imgPath = searchItem.pdImage || '';
  const searchThumbnail = imgPath ? `${IMG_BASE}${imgPath}` : '';

  // 상세 데이터로 보강
  const brand = detail?.brand || searchItem.brandName || '';
  const categorySource = detail?.categorySource || cat.pdStdCategoryId || '';
  const images = detail?.images || (searchThumbnail ? [searchThumbnail] : []);
  const options = detail?.options || [
    { optionName: 'FREE', optionType: 'none', sku: searchItem.sitmId || '', stock: 10, isSoldout: false, priceDiff: 0 }
  ];

  const isSoldout = detail?.isSoldout ?? (searchItem.soldOutYn === 'Y');
  const totalStock = detail?.totalStock ?? (isSoldout ? 0 : 10);

  return {
    sourceMarket: 'lotteon',
    sourceId: searchItem.pdId || '',
    sourceUrl: `https://www.lotteon.com/p/product/${searchItem.pdId}?mall_no=${searchItem.mallNo || searchItem._mallId || 1}`,
    brand,
    originalTitle: detail?.pdName || searchItem.pdName || '',
    originalPrice: Number(price.original || 0),
    sellPrice: Number(price.finalPrice || price.original || 0),
    couponPrice: Number(price.dcAplyTotAmt || 0),
    discount: Number(price.discount || 0),
    categorySource,
    thumbnail: images[0] || searchThumbnail,
    images,
    specs: detail?.specs || {},
    options,
    totalStock,
    isSoldout,
    reviewScore: review.reviewScore || 0,
    reviewCount: review.reviewCount || 0,
    storeName: searchItem.storeName || '',
    todayArrive: delivery.todayArriveYn === 'Y',
    // 혜택가: benefitPrice = 카드 제외 (immdDc), cardBenefitPrice = 카드 포함 (orderDc)
    benefitPrice: benefit?.benefitPrice ?? null,
    cardBenefitPrice: benefit?.cardBenefitPrice ?? null,
    benefitDetails: benefit?.benefitDetails?.length ? JSON.stringify(benefit.benefitDetails) : null,
    // 상품 정보고시
    productNotices: detail?.productNotices ?? null,
    // 배송비
    shippingType: detail?.shippingType ?? 'free',
    shippingFee: detail?.shippingFee ?? 0,
    // 2026-04-21: 소싱처 배송 소요일 (Phase 2 누락 fix) — fetchDetail 에서 bi.thdyPdYn='Y'→1
    // 로 계산된 값을 payload 반환에서 누락하던 버그. Codex 4분류 리뷰에서 발견.
    sourceLeadDays: detail?.sourceLeadDays ?? null,
  };
}

// ─── URL 파싱 ─────────────────────────────────────────────────────────────────

/** URL → 키워드 + mallId 추출 */
export function parseUrl(url) {
  const params = {};
  try {
    const u = new URL(url);
    params.keyword = u.searchParams.get('q') || u.searchParams.get('query') || '';
    // mallId: 롯데백화점=2, 롯데마트=4 등
    const mallId = u.searchParams.get('mallId') || u.searchParams.get('mall_no') || '';
    if (mallId) params.mallId = mallId;
  } catch {
    params.keyword = url;
  }
  return params;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 전체 수집 흐름 — 스트리밍 방식
 * 50개씩 검색→상세→혜택가→서버전송을 반복
 * 서비스워커 crash에 안전: 이미 전송된 데이터는 보존됨
 *
 * options.onBatch(products) — 배치마다 서버에 전송하는 콜백
 */
export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  const keyword = parsed.keyword;
  const mallId = parsed.mallId || '';
  if (!keyword) {
    console.error('[BulkFlow 롯데온] 키워드 없음:', url);
    return [];
  }

  const STREAM_BATCH = 50; // 50개씩 수집+전송
  const seenIds = new Set();
  const allSearchItems = []; // 검색 API 원본 (전체)
  let startIndex = 0;
  let totalSent = 0;

  onProgress(0, 0, 0, '롯데온 검색중...');
  console.log('[BulkFlow 롯데온] 수집 시작:', { keyword, mallId, limit });

  // ── 1단계: 검색 API 목록 수집 — 정렬 pass 다변화 + dedup ──
  //
  // 롯데온 검색 API 는 한 정렬 기준에서 offset > 2,100 이면 빈 페이지 반환.
  // SORT_PASSES 의 각 정렬로 35p × 60 씩 돌린 후 pdId 기준 dedup → 실측
  // ≈6~10k 고유 상품 수집 가능.
  let searchTotal = 0;

  outer: for (const sort of SORT_PASSES) {
    if (allSearchItems.length >= limit) break;
    let passOffset = 0;
    let passPage = 0;

    while (passPage < MAX_PAGES_PER_PASS && allSearchItems.length < limit) {
      try {
        const apiUrl = buildSearchUrl(keyword, passOffset, PAGE_SIZE, { mallId, sort });
        const data = await fetchJson(apiUrl);
        const items = data?.itemList || [];
        if (data?.total && !searchTotal) searchTotal = data.total;

        console.log(
          `[BulkFlow 롯데온] sort=${sort} offset=${passOffset}: ` +
          `${items.length}개 (총 ${searchTotal}개, dedup 후 ${allSearchItems.length}개)`,
        );
        if (items.length === 0) break;

        let passNewItems = 0;
        for (const rawItem_ of items) {
          let rawItem = rawItem_;
          if (!rawItem.pdId && rawItem.productId) {
            const pa = Array.isArray(rawItem.priceInfo) ? rawItem.priceInfo : [];
            const gp = (t) => { const p = pa.find(x => x.type === t); return p ? String(p.num) : ''; };
            rawItem = {
              ...rawItem,
              pdId: rawItem.productId,
              pdName: rawItem.productName || '',
              pdImage: rawItem.productImage?.replace('https://contents.lotteon.com', '') || '',
              sitmId: rawItem.data?.sitm_no || rawItem.key || '',
              mallNo: rawItem.data?.mall_no || (rawItem.productLink?.match(/mall_no=(\d+)/)?.[1]) || '',
              soldOutYn: rawItem.data?.sout === 'y' ? 'Y' : 'N',
              priceInfo: { original: gp('original'), discount: gp('discount'), finalPrice: gp('final'), dcAplyTotAmt: '' },
              categoryInfo: rawItem.brazeData?.categoryNo ? { pdStdCategoryId: rawItem.brazeData.categoryNo } : {},
            };
          }
          if (allSearchItems.length >= limit) break outer;
          const item = normalizeSearchItem(rawItem);
          if (!item.pdId || seenIds.has(item.pdId)) continue;
          if (mallId) item._mallId = mallId;
          seenIds.add(item.pdId);
          allSearchItems.push(item);
          passNewItems++;
        }

        const progress = Math.min(20, Math.round((allSearchItems.length / limit) * 20));
        onProgress(
          progress, searchTotal, allSearchItems.length,
          `검색(${sort}): ${allSearchItems.length}/${Math.min(limit, searchTotal || limit)}`,
        );

        passOffset += PAGE_SIZE;
        passPage++;
        // 같은 정렬에서 신규가 0 이면 이 정렬로는 더 얻을 게 없음 → 다음 정렬로
        if (passNewItems === 0) break;
        if (items.length < PAGE_SIZE) break;
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.error(`[BulkFlow 롯데온] 검색 오류 (sort=${sort}):`, err.message);
        break;
      }
    }
  }

  if (allSearchItems.length === 0) {
    onProgress(100, 0, 0, '검색 결과 없음');
    return [];
  }

  console.log(`[BulkFlow 롯데온] 검색 완료: ${allSearchItems.length}개 → ${STREAM_BATCH}개씩 스트리밍 처리`);

  // ── 2단계: 50개씩 상세+혜택가+전송 ──
  const allProducts = [];

  for (let batchStart = 0; batchStart < allSearchItems.length; batchStart += STREAM_BATCH) {
    const batchItems = allSearchItems.slice(batchStart, batchStart + STREAM_BATCH);
    const batchNum = Math.floor(batchStart / STREAM_BATCH) + 1;
    const totalBatches = Math.ceil(allSearchItems.length / STREAM_BATCH);

    console.log(`[BulkFlow 롯데온] 배치 ${batchNum}/${totalBatches}: ${batchItems.length}개 처리중`);

    const effectiveMallNo = mallId || 1;

    // 상세 조회 (3개 동시)
    const details = new Map();
    for (let i = 0; i < batchItems.length; i += DETAIL_CONCURRENCY) {
      const chunk = batchItems.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.allSettled(chunk.map(async (item) => {
        const detail = await fetchDetail(item.pdId, item.mallNo || effectiveMallNo);
        details.set(item.pdId, detail);
      }));
      if (i + DETAIL_CONCURRENCY < batchItems.length) {
        await new Promise(r => setTimeout(r, DETAIL_DELAY));
      }
    }

    // 혜택가 조회 (3개 동시)
    const benefits = new Map();
    for (let i = 0; i < batchItems.length; i += DETAIL_CONCURRENCY) {
      const chunk = batchItems.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.allSettled(chunk.map(async (item) => {
        const benefit = await fetchBenefitPrice(item.pdId, item.mallNo || effectiveMallNo);
        benefits.set(item.pdId, benefit);
      }));
      if (i + DETAIL_CONCURRENCY < batchItems.length) {
        await new Promise(r => setTimeout(r, DETAIL_DELAY));
      }
    }

    // 조합 → 서버 전송
    const batchProducts = batchItems.map(item => {
      const detail = details.get(item.pdId) || null;
      const benefit = benefits.get(item.pdId) || null;
      return parseItem(item, detail, benefit);
    });

    // onBatch 콜백으로 즉시 서버 전송
    if (options.onBatch) {
      try {
        await options.onBatch(batchProducts);
        totalSent += batchProducts.length;
      } catch (e) {
        console.error(`[BulkFlow 롯데온] 배치 ${batchNum} 전송 실패:`, e.message);
      }
    }

    allProducts.push(...batchProducts);

    // 진행률 업데이트
    const progress = 20 + Math.round(((batchStart + batchItems.length) / allSearchItems.length) * 80);
    onProgress(progress, allSearchItems.length, totalSent || allProducts.length, `처리: ${allProducts.length}/${allSearchItems.length}`);
  }

  const withOptions = allProducts.filter(p => p.options.length > 1).length;
  const withBenefit = allProducts.filter(p => p.benefitPrice).length;
  onProgress(100, allProducts.length, allProducts.length, '수집 완료');
  console.log(`[BulkFlow 롯데온] 완료: ${allProducts.length}개 (옵션: ${withOptions}, 혜택가: ${withBenefit})`);
  return allProducts;
}
