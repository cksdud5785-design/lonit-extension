/**
 * 무신사 수집 엔진
 * 사용자 브라우저에서 실행 — 서버 부하 0
 *
 * v1.0.3 (2026-04-10): 쿠폰 API 통합 + 선할인 제거
 *   - getDetail 에서 상품 쿠폰 API 호출
 *     등급 전용 쿠폰(LV.8 다이아 등)이 __NEXT_DATA__ 에 없어서 benefit_price 가
 *     과대평가되던 버그 (5707128: 167,680 → 164,220)
 *   - calcMaxBenefitPrice 가 salePrice - 쿠폰(API) - 등급 체인 (선할인 제거)
 *     Musinsa UI "최대혜택가" 기본값이 "구매 적립" 모드라 선할인(-) 자동 적용은 UI 불일치
 *   - musinsaRaw.couponDiscount 에 API 값 반영 (장바구니 쿠폰은 매입가 계산 제외)
 *
 * v1.0.2 (이력): calcMaxBenefitPrice 에서 보유 적립금(ownPoint) 차감 제거 + isLimitedDc 게이트
 */
// 2026-05-26: 새 탭 가시성 fix — chrome.tabs.create({active:false}) 가 탭 바에 표시되던
// 문제 해결. popup window + off-screen position 패턴으로 교체 (hidden-tab.js 헬퍼).
import { createHiddenTab } from './hidden-tab.js';

console.log('[Lonit] musinsa.js v1.1.6 benefit chain(병렬 benefit API)');

const DELAY_MIN = 120;
const DELAY_MAX = 260;
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
let _musinsaTabId = null; // 최대혜택가 탭 재사용

// 2026-06-12: AIMD 적응 스로틀(SSG/abcmart 동일 패턴). 차단(403/429) 0 이면 기준 딜레이를
//   하한까지 가속, 차단 신호엔 ×2 백오프 + cliff 기억. "차단되지 않는 최대 지속률" 탐색.
//   기존 고정 120-260ms(anti-bot 튜닝값)에서 시작해 무차단 시 60ms 까지 내려감.
const MUSINSA_DELAY_FLOOR_MS = 60;     // 가속 하한
const MUSINSA_DELAY_MAX_MS = 8000;
const MUSINSA_SPEED_UP_EVERY = 8;      // 성공 8회마다 ×0.85
const MUSINSA_FLOOR_MARGIN = 1.25;     // 차단난 딜레이보다 25% 여유
const MUSINSA_FLOOR_DECAY = 0.96;
let _musinsaDelayMs = 190;             // 적응 기준(시작=기존 평균)
let _musinsaSafeFloorMs = MUSINSA_DELAY_FLOOR_MS;
let _musinsaSuccessStreak = 0;

function markMusinsaBlocked() {
  // 차단난 딜레이 = 더 빠르면 안 되는 한계 → 바닥을 그보다 25% 여유로 끌어올림.
  _musinsaSafeFloorMs = Math.min(MUSINSA_DELAY_MAX_MS, Math.max(_musinsaSafeFloorMs, Math.floor(_musinsaDelayMs * MUSINSA_FLOOR_MARGIN)));
  _musinsaDelayMs = Math.min(MUSINSA_DELAY_MAX_MS, Math.max(MUSINSA_DELAY_FLOOR_MS, Math.floor(_musinsaDelayMs * 2)));
  _musinsaSuccessStreak = 0;
  persistMusinsaState(true);   // 학습된 cliff 즉시 보존(SW 종료 전 유실 방지)
}

function markMusinsaSuccess() {
  if (++_musinsaSuccessStreak < MUSINSA_SPEED_UP_EVERY) return;
  _musinsaSuccessStreak = 0;
  const next = Math.max(_musinsaSafeFloorMs, Math.floor(_musinsaDelayMs * 0.85));
  if (next < _musinsaDelayMs) {
    _musinsaDelayMs = next;           // 학습된 안전 바닥까지 가속
    persistMusinsaState();
  } else if (_musinsaSafeFloorMs > MUSINSA_DELAY_FLOOR_MS) {
    _musinsaSafeFloorMs = Math.max(MUSINSA_DELAY_FLOOR_MS, Math.floor(_musinsaSafeFloorMs * MUSINSA_FLOOR_DECAY));
    _musinsaDelayMs = Math.max(_musinsaSafeFloorMs, Math.floor(_musinsaDelayMs * 0.92));
    persistMusinsaState();
  }
}

// 2026-06-12: 적응 상태(학습된 안전속도)를 SW 재시작 너머로 보존(SSG 와 동일 패턴).
//   MV3 서비스워커 잦은 종료 → 매번 시작값(190)으로 재학습하면 같은 한계 재차단. 학습값 복원으로
//   수렴 유지. 복원값은 과거 "차단 안 되던" 값이라 차단 위험 추가 없음(하한 클램프).
const MUSINSA_STATE_KEY = 'musinsaAdaptiveState';
let _musinsaPersistTimer = null;
function persistMusinsaState(immediate = false) {
  const write = () => {
    _musinsaPersistTimer = null;
    try {
      chrome.storage.local.set({ [MUSINSA_STATE_KEY]: { delayMs: _musinsaDelayMs, safeFloorMs: _musinsaSafeFloorMs, at: Date.now() } });
    } catch { /* SW 종료 등 무시 */ }
  };
  if (immediate) { if (_musinsaPersistTimer) clearTimeout(_musinsaPersistTimer); write(); return; }
  if (_musinsaPersistTimer) return;
  _musinsaPersistTimer = setTimeout(write, 10_000);
}
async function restoreMusinsaState() {
  try {
    const got = await chrome.storage.local.get(MUSINSA_STATE_KEY);
    const s = got?.[MUSINSA_STATE_KEY];
    if (!s) return;
    if (Number.isFinite(s.safeFloorMs)) {
      _musinsaSafeFloorMs = Math.min(MUSINSA_DELAY_MAX_MS, Math.max(MUSINSA_DELAY_FLOOR_MS, Math.floor(s.safeFloorMs)));
    }
    if (Number.isFinite(s.delayMs)) {
      _musinsaDelayMs = Math.min(MUSINSA_DELAY_MAX_MS, Math.max(_musinsaSafeFloorMs, Math.floor(s.delayMs)));
    }
  } catch { /* 무시 */ }
}
restoreMusinsaState();

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 적응 기준 딜레이 ±25% 지터(핑거프린트 회피 유지).
function randomDelay() {
  return delay(Math.floor(_musinsaDelayMs * (0.75 + Math.random() * 0.5)));
}

function getHeaders() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://www.musinsa.com/',
    'Origin': 'https://www.musinsa.com',
  };
}

// 서비스워커에서 credentials:'include'가 cross-origin 쿠키 누락 → 수동 주입
async function getMusinsaHeaders() {
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const c1 = await chrome.cookies.getAll({ domain: '.musinsa.com' });
      const c2 = await chrome.cookies.getAll({ domain: 'www.musinsa.com' });
      const cookieMap = new Map();
      for (const c of c1) cookieMap.set(c.name, c);
      for (const c of c2) cookieMap.set(c.name, c);
      const cookies = [...cookieMap.values()];
      if (cookies.length > 0) {
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
        return { ...getHeaders(), 'Cookie': cookieStr };
      }
    }
  } catch {}
  return getHeaders();
}

async function musinsaFetch(url, init = {}, context = 'musinsa') {
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(await getMusinsaHeaders()),
        ...(init.headers || {}),
      },
    });

    if (resp.ok) { markMusinsaSuccess(); return resp; }

    // 403/429 = anti-bot 차단 신호 → 적응 백오프(5xx 는 서버오류라 제외).
    if (resp.status === 403 || resp.status === 429) markMusinsaBlocked();

    if (!RETRYABLE_STATUSES.has(resp.status) || attempt >= maxRetries) {
      throw new Error(`Musinsa ${resp.status}: ${context}`);
    }

    const waitMs = resp.status === 429
      ? Math.min(15000, 2000 * Math.pow(2, attempt))
      : 800 + (attempt * 700);
    console.warn(`[BulkFlow] 무신사 재시도 ${context}: ${resp.status}, ${waitMs}ms 대기 (${attempt + 1}/${maxRetries})`);
    await delay(waitMs);
  }

  throw new Error(`Musinsa fetch failed: ${context}`);
}

function toMoney(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function optionalMoney(value) {
  if (value == null || value === '') return undefined;
  const n = toMoney(value);
  return Number.isFinite(n) ? Math.max(Math.floor(n), 0) : undefined;
}

function readFirstMoney(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const n = toMoney(obj[key]);
    if (n > 0) return n;
  }
  return 0;
}

function readOptionalMoney(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const n = optionalMoney(obj[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function isYes(value) {
  return value === true || value === 'Y' || value === 'y' || value === 'YES' || value === '1' || value === 1;
}

function isNo(value) {
  return value === false || value === 'N' || value === 'n' || value === 'NO' || value === '0' || value === 0;
}

const COUPON_AMOUNT_KEYS = [
  'salePrice',
  'discountAmount',
  'discountPrice',
  'dcPrice',
  'dcAmt',
  'couponDcPrice',
  'couponDiscount',
  'couponDiscountAmount',
  'couponDiscountPrice',
  'applyDiscountAmount',
  'appliedDiscountAmount',
  'benefitAmount',
];

function getCouponCandidateAmount(coupon) {
  return readFirstMoney(coupon, COUPON_AMOUNT_KEYS);
}

function isSelectedCoupon(coupon) {
  return isYes(coupon?.selected)
    || isYes(coupon?.isSelected)
    || isYes(coupon?.checked)
    || isYes(coupon?.applied)
    || isYes(coupon?.isApplied)
    || isYes(coupon?.selectedYn)
    || isYes(coupon?.applyYn)
    || isYes(coupon?.appliedYn)
    || isYes(coupon?.defaultYn)
    || isYes(coupon?.isDefault)
    || isYes(coupon?.autoApplyYn);
}

function isUsableCoupon(coupon) {
  if (!coupon || typeof coupon !== 'object') return false;
  if (isNo(coupon.usableYn) || isNo(coupon.useYn) || isNo(coupon.canUse) || isYes(coupon.disabled)) return false;
  return isYes(coupon.usableYn)
    || isYes(coupon.useYn)
    || isYes(coupon.canUse)
    || isYes(coupon.issuedYn)
    || isYes(coupon.issueYn)
    || isYes(coupon.downloadedYn)
    || coupon.usable === true;
}

function collectCouponLists(json) {
  const data = json?.data || json || {};
  const lists = [];
  for (const holder of [data, data.summaryInformation, data.coupon, data.couponInfo]) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of [
      'list',
      'coupons',
      'couponList',
      'usableCoupons',
      'usableCouponList',
      'goodsCouponList',
      'downloadableCouponList',
      'items',
    ]) {
      if (Array.isArray(holder[key])) lists.push(holder[key]);
    }
  }
  return lists;
}

function pickCouponDiscountFromResponse(json, { preferSummary = false } = {}) {
  const data = json?.data || json || {};
  const summaryAmount = readFirstMoney(data?.summaryInformation, COUPON_AMOUNT_KEYS)
    || readFirstMoney(data?.summary, COUPON_AMOUNT_KEYS);

  if (preferSummary && summaryAmount > 0) return summaryAmount;

  const candidates = collectCouponLists(json)
    .flat()
    .filter((coupon) => coupon && typeof coupon === 'object' && getCouponCandidateAmount(coupon) > 0);

  const selected = candidates.find(isSelectedCoupon);
  if (selected) return getCouponCandidateAmount(selected);

  const usable = candidates.find(isUsableCoupon);
  if (usable) return getCouponCandidateAmount(usable);

  const best = candidates.find((coupon) => coupon.bestSalePriceYn === 'Y');
  if (best) return getCouponCandidateAmount(best);

  if (candidates.length > 0) return getCouponCandidateAmount(candidates[0]);

  return summaryAmount || 0;
}

function readDetailCouponDiscount(detailData, salePrice) {
  const direct = readFirstMoney(detailData, [
    'couponDcPrice',
    'couponDiscountAmount',
    'couponDiscountPrice',
    'couponDiscount',
  ]);
  if (direct > 0) return direct;

  const gp = detailData?.goodsPrice || {};
  const gpDirect = readFirstMoney(gp, [
    'couponDcPrice',
    'couponDiscountAmount',
    'couponDiscountPrice',
  ]);
  if (gpDirect > 0) return gpDirect;

  const couponPrice = toMoney(gp.couponPrice ?? detailData?.couponPrice);
  if (salePrice > 0 && couponPrice > 0 && salePrice > couponPrice) {
    return salePrice - couponPrice;
  }
  return 0;
}

function readExactDiscounts(detailData) {
  const gp = detailData?.goodsPrice || {};
  const gradeKeys = [
    'gradeDiscountAmount',
    'gradeDiscount',
    'memberDiscountAmount',
    'memberDiscountPrice',
    'memberDcPrice',
    'membershipDiscountAmount',
  ];
  const prePointKeys = [
    'prePointDiscountAmount',
    'prePointDiscount',
    'prePointAmount',
    'prePointDcPrice',
    'advancePointDiscountAmount',
  ];
  const ownPointKeys = [
    'ownPointDiscountAmount',
    'ownPointDiscount',
    'usePointAmount',
    'pointUseAmount',
  ];
  return {
    gradeDiscountAmount: readOptionalMoney(detailData, gradeKeys) ?? readOptionalMoney(gp, gradeKeys),
    prePointDiscountAmount: readOptionalMoney(detailData, prePointKeys) ?? readOptionalMoney(gp, prePointKeys),
    ownPointDiscountAmount: readOptionalMoney(detailData, ownPointKeys) ?? readOptionalMoney(gp, ownPointKeys),
  };
}

function mergeBenefitApiData(htmlData, apiData) {
  if (!apiData || typeof apiData !== 'object') return htmlData;
  return {
    ...htmlData,
    ...apiData,
    goodsPrice: {
      ...(htmlData?.goodsPrice || {}),
      ...(apiData.goodsPrice || {}),
    },
    point: {
      ...(htmlData?.point || {}),
      ...(apiData.point || {}),
    },
  };
}

async function fetchGoodsBenefitApi(goodsNo) {
  try {
    const resp = await musinsaFetch(
      `https://goods-detail.musinsa.com/api2/goods/${goodsNo}`,
      {},
      `benefit-api ${goodsNo}`,
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.meta?.result !== 'SUCCESS') return null;
    return json.data || null;
  } catch (e) {
    console.warn(`[BulkFlow] Musinsa benefit API failed ${goodsNo}:`, e.message);
    return null;
  }
}

/** URL → 검색 파라미터 파싱 */
export function parseUrl(url) {
  const params = {};
  try {
    const u = new URL(url);
    const catMatch = u.pathname.match(/\/categories\/(\d+)/);
    if (catMatch) {
      const code = catMatch[1];
      if (code.length <= 3) params.category1DepthCode = code;
      else params.category2DepthCode = code;
    }
    const brandMatch = u.pathname.match(/\/brand[s]?\/([^/]+)(?:\/products)?(?:\/|$)/);
    if (brandMatch) {
      params.brand = brandMatch[1];
      params.caller = 'BRAND';
    }
    if (u.searchParams.has('keyword')) params.keyword = u.searchParams.get('keyword');
    for (const [k, v] of u.searchParams) {
      if (['category1DepthCode', 'category2DepthCode', 'brand', 'minPrice', 'maxPrice', 'sortCode', 'gf'].includes(k)) {
        params[k] = v;
      }
    }
  } catch {
    params.keyword = url;
  }
  return params;
}

/** 검색 API */
export async function searchProducts(params) {
  const caller = params.caller || (params.brand && !params.keyword && !params.category1DepthCode && !params.category2DepthCode
    ? 'BRAND'
    : 'SEARCH');
  const qs = new URLSearchParams({
    gf: params.gf || 'A',
    keyword: params.keyword || '',
    sortCode: params.sort || 'POPULAR',
    page: String(params.page || 1),
    size: String(params.size || 60),
    caller,
  });
  if (params.brand) qs.set('brand', params.brand);
  if (params.category1DepthCode) qs.set('category1DepthCode', params.category1DepthCode);
  if (params.category2DepthCode) qs.set('category2DepthCode', params.category2DepthCode);
  if (params.minPrice != null) qs.set('minPrice', String(params.minPrice));
  if (params.maxPrice != null) qs.set('maxPrice', String(params.maxPrice));

  const resp = await musinsaFetch(`https://api.musinsa.com/api2/dp/v2/plp/goods?${qs}`, {}, `search ${params.keyword || params.brand || params.category2DepthCode || params.category1DepthCode || 'query'}`);
  const json = await resp.json();
  if (json.meta?.result !== 'SUCCESS') throw new Error('Search failed');

  return {
    list: (json.data?.list || []).map(item => ({
      goodsNo: item.goodsNo,
      goodsName: item.goodsName,
      brand: item.brand,
      brandName: item.brandName,
      thumbnail: item.thumbnail,
      normalPrice: item.normalPrice,
      price: item.price,
      couponPrice: item.couponPrice,
      saleRate: item.saleRate,
      isSoldOut: item.isSoldOut,
    })),
    totalCount: json.data?.pagination?.totalCount || 0,
    hasNext: json.data?.pagination?.hasNext || false,
  };
}

/**
 * 무신사 상품 쿠폰 API — bestSalePriceYn='Y' 쿠폰의 할인 금액 반환
 * 등급 전용 쿠폰(LV.8 다이아 등)은 __NEXT_DATA__ 에 없고 이 API 로만 조회됨.
 * 쿠키(로그인) 포함해서 개인화 쿠폰 가져옴.
 */
async function fetchBestCouponDiscount(goodsNo, brand, comId, salePrice) {
  try {
    const qs = new URLSearchParams({
      goodsNo: String(goodsNo),
      brand: brand || '',
      comId: comId || '',
      salePrice: String(salePrice || 0),
    });
    const resp = await fetch(
      `https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo?${qs}`,
      { headers: await getMusinsaHeaders() },
    );
    if (!resp.ok) return 0;
    const json = await resp.json();
    return pickCouponDiscountFromResponse(json);
  } catch { return 0; }
}

/**
 * 목적: 최대혜택가 계산 (Musinsa UI 기본 표시 값과 일치)
 * 공식: salePrice → 상품쿠폰(API) → 등급할인 → 선할인
 * cut10 = 10원 단위 절사 (무신사 프론트엔드 방식)
 *
 * v1.1.5 (2026-05-06): 등급할인과 선할인 체인을 서버 계산식과 일치
 *   - 등급할인은 쿠폰 차감 후 현재가 기준, 선할인은 등급할인 후 현재가 기준
 *   - 보유 적립금(ownPoint)은 미적용
 *
 * @param {object} data   무신사 __NEXT_DATA__ 의 상품 데이터
 * @param {object} [opts] { couponDiscount, cartCouponDiscount } 쿠폰 API 에서 가져온 실제 할인액
 */
function calcMaxBenefitPrice(data, opts = {}) {
  const gp = data.goodsPrice || {};
  const salePrice = gp.salePrice || gp.normalPrice || 0;
  if (!salePrice) return 0;

  const cut10 = (v) => Math.floor(v / 10) * 10;
  const couponDiscount = Math.max(0, opts.couponDiscount || 0);
  const memberDiscountRate = Math.max(0, opts.memberDiscountRate ?? gp.memberDiscountRate ?? 0);
  const memberSavePointRate = Math.max(0, opts.memberSavePointRate ?? gp.memberSavePointRate ?? 0);
  const savePoint = Math.max(0, opts.savePoint ?? gp.savePoint ?? 0);
  const exactGradeDiscount = optionalMoney(opts.gradeDiscountAmount);
  const exactPrePointDiscount = optionalMoney(opts.prePointDiscountAmount);

  let price = salePrice;
  let gradeDiscount = 0;
  let prePointDiscount = 0;

  // 1. Product coupons only. Cart coupons are basket-level and must not change source unit cost.
  if (!data.isLimitedCoupon) {
    price -= couponDiscount;
  }

  if (!data.isLimitedDc && (memberDiscountRate > 0 || exactGradeDiscount !== undefined)) {
    gradeDiscount = exactGradeDiscount !== undefined
      ? exactGradeDiscount
      : cut10(price * memberDiscountRate / 100);
    price -= gradeDiscount;
  }

  if (data.isPrePoint) {
    if (exactPrePointDiscount !== undefined) {
      prePointDiscount = exactPrePointDiscount;
    } else {
      const memberPrePointDiscount = memberSavePointRate > 0
        ? cut10(price * memberSavePointRate / 100)
        : 0;
      prePointDiscount = savePoint + memberPrePointDiscount;
    }
    price -= prePointDiscount;
  }

  return {
    benefitPrice: Math.max(price, 0),
    gradeDiscount,
    prePointDiscount,
  };
}

/** Content Script로 무신사 최대혜택가 DOM 파싱 (CSR 렌더링 후) */
export async function fetchBenefitViaTab(goodsNo) {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) return null;
  const url = `https://www.musinsa.com/products/${goodsNo}`;
  try {
    if (_musinsaTabId) {
      try {
        await chrome.tabs.update(_musinsaTabId, { url, active: false });
      } catch {
        const tab = await createHiddenTab(url);
        _musinsaTabId = tab.id;
      }
    } else {
      const tab = await createHiddenTab(url);
      _musinsaTabId = tab.id;
    }
    // 로드 대기
    await new Promise((resolve) => {
      const onUpdated = (tabId, info) => {
        if (tabId === _musinsaTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 8000);
    });
    // CSR 렌더링 대기
    await delay(2000);
    // DOM에서 최대혜택가 파싱
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: _musinsaTabId },
      func: () => {
        // "최대혜택가" 텍스트를 포함하는 요소 근처에서 가격 추출
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const text = el.textContent || '';
          if (text.includes('최대혜택가') && el.children.length < 5) {
            const priceMatch = text.match(/([\d,]+)\s*원/);
            if (priceMatch) return parseInt(priceMatch[1].replace(/,/g, ''), 10);
          }
        }
        return null;
      },
    });
    return result?.result || null;
  } catch (e) {
    console.warn(`[BulkFlow] 무신사 Content Script 실패 ${goodsNo}:`, e.message);
    return null;
  }
}

/** 무신사 최대혜택가 탭 정리 */
export function cleanupMusinsaTab() {
  if (_musinsaTabId) {
    try { chrome.tabs.remove(_musinsaTabId); } catch {}
    _musinsaTabId = null;
  }
}

// ─── 불필요 이미지 URL 패턴 필터 (항상 적용) ─────────────────────
// 피부색 감지/크롭 제거 — base64 변환으로 payload 폭증 이슈.
// URL 패턴만으로 model/outro/intro/lookbook/size 이미지를 제거.
// apps/api/src/workers/musinsa-image-classifier.ts 패턴 미러링.

// 2026-04-19: 확장 — styling/styled/look/pose/shot/feat/cuts/human/person/body shot 추가.
// delimiter 경계 [/_.\-] = 슬래시/언더스코어/마침표(확장자)/하이픈 —
// 브랜드 CDN 의 _model.jpg, _wearing.jpg, _styling.png 등 확장자 직전 매치 커버.
const _DROP_URL_PATTERNS = [
  // 모델컷 (일반 키워드)
  /[/_.\-]model[/_.\-]/i,
  /[/_.\-]wearing[/_.\-]/i,
  /[/_.\-]lookbook[/_.\-]/i,
  /[/_.\-]styling[/_.\-]/i,
  /[/_.\-]styled[/_.\-]/i,
  /[/_.\-]look_?\d+[/_.\-]/i,
  /[/_.\-]pose\d*[/_.\-]/i,
  /[/_.\-]shot\d*[/_.\-]/i,
  /[/_.\-]feat(?:uring)?[/_.\-]/i,
  /[/_.\-]cuts?\d*[/_.\-]/i,
  /[/_.\-]human[/_.\-]/i,
  /[/_.\-]person[/_.\-]/i,
  /[/_.\-]body_?shot\d*[/_.\-]/i,
  // 아웃트로/인트로 (브랜드 소개 이미지)
  /[/_-]outro[/_-]?\d*/i,
  /\/outro/i,
  /[/_-]intro[/_-]?\d*/i,
  /\/intro\//i,
  // 사이즈 차트 (별도 sizeGuideImages 로 수집)
  /\/size(?:info|chart|guide)?[/_-]/i,
  /[/_-]size(?:info|chart|guide)?\//i,
  /\/measure[/_-]/i,
  /\/sizing[/_-]/i,
];

// 2026-04-19: alt 텍스트 기반 모델컷 감지 (한국어 + 영어).
// 백엔드 MODEL_CUT_ALT_RE 와 동일 — musinsa-image-classifier.ts.
const _MODEL_CUT_ALT_RE = /모델|착용|입은|룩북|스타일링|웨어|wear(?:ing)?|look\s*book|styling|styled|pose|shot|feat(?:uring)?/i;

function _isDroppableByUrl(url) {
  return _DROP_URL_PATTERNS.some(re => re.test(url));
}

/**
 * URL 패턴으로 불필요 이미지 제거 (model/outro/intro/lookbook/size).
 * 설정 불필요 — 항상 적용. 최소 1장 유지.
 */
function filterImagesByUrlPattern(urls) {
  if (!urls || urls.length === 0) return urls;
  const dropped = [];
  const kept = [];
  for (const url of urls) {
    if (_isDroppableByUrl(url)) {
      dropped.push(url);
    } else {
      kept.push(url);
    }
  }
  if (dropped.length > 0) {
    console.log(`[BulkFlow] URL 패턴 제거 ${dropped.length}장 (model/outro/intro/size)`);
  }
  return kept.length > 0 ? kept : [urls[0]];
}

// ─── 브랜드별 상세 이미지 필터 Rule Table ─────────────────────
// apps/api/src/modules/musinsa/brand-rules.ts 의 JS 미러
// IMPORTANT: TS 버전 수정 시 이 블록도 동시 수정 (extension ↔ backend divergence 방지)
const MUSINSA_BRAND_RULES = [
  {
    hostPattern: /img\.pastelmall\.com/i,
    brandSlug: 'daks',
    dropTokens: ['notice', 'guide', 'common', 'banner', 'detail_top', 'detail_bottom', 'pastelmall_top', 'extmall_bottom'],
    sizeGuidePaths: [/\/size\//i],
  },
  {
    hostPattern: /toossa\.com|kolonmall\.com/i,
    brandSlug: 'kolonsport',
    dropTokens: ['notice', 'guide', 'kakao', 'banner'],
    sizeGuidePaths: [/\/size\//i],
  },
  {
    hostPattern: /jinjoocompany\.imghost\.cafe24\.com/i,
    dropTokens: ['musinsaguide', 'notice', 'banner'],
    sizeGuidePaths: [],
  },
  // 2026-04-19: 리(LEE) — leekorea.co.kr 자체 CDN. _02/_03 suffix 가 모델컷.
  // 예: LE2602SS65WH_01.jpg (제품컷 유지), LE2602SS65WH_02.jpg (모델컷 drop).
  {
    hostPattern: /leekorea\.co\.kr/i,
    brandSlug: 'lee',
    dropTokens: ['notice', 'guide', 'common', 'banner', '02', '03'],
    sizeGuidePaths: [/\/size\//i],
  },
];

const MUSINSA_DEFAULT_RULE = {
  hostPattern: /.*/,
  dropTokens: [
    'notice', 'guide', 'common', 'banner',
    'kakao', 'extmall', 'return',
    'musinsaguide', 'detail_top', 'detail_bottom',
    // 2026-04-17: 브랜드 CDN (assets.adidas.com 등) 공통 notice 이미지 drop.
    'precaution', 'warning', 'quality', 'assurance',
    // 2026-04-17: size chart 는 sizeGuideImages 로 분류 — detail 에서 제외.
    'sizechart', 'sizeguide',
  ],
  // 2026-04-17: 브랜드 CDN 의 size chart 파일명 패턴 추가.
  sizeGuidePaths: [/\/size\//i, /size[-_]?(?:chart|guide)/i],
};

function _musinsaFindRule(url) {
  for (const rule of MUSINSA_BRAND_RULES) {
    if (rule.hostPattern.test(url)) return rule;
  }
  return MUSINSA_DEFAULT_RULE;
}

function _musinsaEscapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Delimiter 기반 token matching: `[\/_.\-]` 양쪽 경계 + 토큰 뒤 숫자 허용
// `_notice_`, `/notice/`, `notice.jpg`, `musinsaguide3.jpg` 매치
// `noticeless_product` 는 토큰 뒤 `less` 가 숫자/delimiter 아니므로 false
function _musinsaIsDropUrl(url, rule) {
  const path = url.toLowerCase();
  for (const token of rule.dropTokens) {
    const regex = new RegExp(`[\\/_.\\-]${_musinsaEscapeRegex(token)}\\d*[\\/_.\\-]`, 'i');
    if (regex.test(path)) return true;
  }
  return false;
}

/** 상세 HTML에서 이미지 URL 추출 — brand rule + URL pattern blocklist 만 적용
 *
 * 2026-04-17: host=msscdn.net 전용 filter 제거.
 * 이유: adidas 등 브랜드가 자체 CDN (assetmanagerpim-res.cloudinary.com, assets.adidas.com
 * 등) 에 상세 이미지를 호스팅하는 케이스에서 이 filter 가 모든 이미지를 drop 하던 버그.
 * 예: product 201972 (adidas 프리미엄 재킷 KS5337) — 15 장 상세 이미지 모두 adidas
 * cloudinary. 기존: 전부 drop → detail_images=[].  수정 후: brand rule (notice/guide/
 * banner) + URL pattern (model/outro/intro/size) 으로만 filter → 실제 상품 이미지 유지.
 *
 * 백엔드 TS mirror (apps/api/src/modules/musinsa/extract-detail-images.ts) 과 동일
 * 정책 — 확장·백엔드 divergence 해소.
 */
// 2026-04-19: <img> 태그 단위 파싱 + alt 텍스트 필터 추가.
// 백엔드 extract-detail-images.ts 와 동일 정책:
//   - src/data-src 로 URL 추출
//   - alt 에 "모델/착용/룩북/wearing" 키워드 있으면 드롭 (브랜드 HTML 본문 모델컷 커버)
//   - _DROP_URL_PATTERNS 로 URL 키워드 차단
//   - brand rules dropTokens 로 정책/배너 차단
function extractDetailImages(html) {
  if (!html) return [];
  const imgTagRe = /<img\b[^>]*>/gi;
  const srcRe = /(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/i;
  const altRe = /\balt=["']([^"']*)["']/i;
  const seen = new Set();
  const kept = [];
  for (const tagMatch of html.matchAll(imgTagRe)) {
    const tag = tagMatch[0];
    const srcMatch = tag.match(srcRe);
    if (!srcMatch) continue;
    const rawUrl = srcMatch[1];
    const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
    if (seen.has(url)) continue;
    seen.add(url);
    // URL 키워드 모델컷 drop
    if (_isDroppableByUrl(url)) continue;
    // alt 텍스트 모델컷 drop
    const altMatch = tag.match(altRe);
    const alt = altMatch ? altMatch[1] : '';
    if (alt && _MODEL_CUT_ALT_RE.test(alt)) continue;
    // brand rule dropTokens (정책/배너)
    const rule = _musinsaFindRule(url);
    if (_musinsaIsDropUrl(url, rule)) continue;
    kept.push(url);
  }
  return kept;
}

// ─── 사이즈표 파서 ────────────────────────────────────────────
// apps/api/src/modules/musinsa/parse-size-table.ts + extract-size-guide-images.ts 의 JS 미러
// IMPORTANT: TS 버전 수정 시 이 블록도 동시 수정

const _SIZE_HEADER_KEYWORDS = [
  '총장', '어깨너비', '가슴단면', '소매길이', '밑단', '허리', '허벅지',
  '밑위', '밑단길이', '엉덩이', '발폭', '발길이',
];

function _stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function _parseSizeTable(html) {
  if (!html) return null;
  try {
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tm;
    while ((tm = tableRegex.exec(html)) !== null) {
      const tableHtml = tm[1];
      const rows = [];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rm;
      while ((rm = rowRegex.exec(tableHtml)) !== null) {
        const cells = [];
        const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cm;
        while ((cm = cellRegex.exec(rm[1])) !== null) {
          cells.push(_stripTags(cm[1]));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length < 2) continue;

      const headerRow = rows[0];
      const hasSize = headerRow.some(h => _SIZE_HEADER_KEYWORDS.some(kw => h.includes(kw)));
      if (!hasSize) continue;

      const headers = headerRow.slice(1).filter(h => _SIZE_HEADER_KEYWORDS.some(kw => h.includes(kw)));
      if (headers.length === 0) continue;

      const dataRows = rows.slice(1).map(r => ({
        size: r[0] || '',
        values: r.slice(1, headers.length + 1),
      }));

      const unit = /cm/i.test(headerRow[0] || '') ? 'cm' : (/mm/i.test(headerRow[0] || '') ? 'mm' : null);
      return { headers, rows: dataRows, unit };
    }
    return null;
  } catch (e) { console.warn('[musinsa] sizeTable parse error', e); return null; }
}

function _extractSizeGuideImages(html) {
  if (!html) return [];
  const re = /(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/gi;
  const raw = [];
  let m;
  while ((m = re.exec(html)) !== null) raw.push(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
  const unique = [...new Set(raw)];
  return unique.filter(url => {
    const rule = _musinsaFindRule(url);
    return rule.sizeGuidePaths.length > 0 && rule.sizeGuidePaths.some(pathRe => pathRe.test(url));
  });
}

// ─── 신발 기준표 사이즈 fallback ─────────────────────────────
// 무신사 "사이즈 정보 > 기준표 사이즈 > 신발 일반" 표준 변환표
// actual-size API 가 data: null 인 신발 상품용 fallback
// IMPORTANT: apps/api/src/modules/musinsa/standard-shoe-sizes.ts 와 동기화

const _SHOE_SIZE_HEADERS = ['일본(cm)', '미국(남)', '미국(여)', '영국(남)', '영국(여)', '유럽(남)', '유럽(여)'];
const _SHOE_SIZE_MAP = new Map([
  [220, ['22',   '-',    '5',    '-',   '3',   '-',    '36']],
  [225, ['22.5', '-',    '5.5',  '-',   '3.5', '-',    '36.5']],
  [230, ['23',   '-',    '6',    '-',   '4',   '-',    '37']],
  [235, ['23.5', '-',    '6.5',  '-',   '4.5', '-',    '37.5']],
  [240, ['24',   '6',    '7',    '5',   '5',   '38',   '38']],
  [245, ['24.5', '6.5',  '7.5',  '-',   '5.5', '-',    '38.5']],
  [250, ['25',   '7',    '8',    '6',   '6',   '39',   '39']],
  [255, ['25.5', '7.5',  '8.5',  '-',   '6.5', '-',    '39.5']],
  [260, ['26',   '8',    '9',    '7',   '7',   '40.5', '40']],
  [265, ['26.5', '8.5',  '9.5',  '7.5', '7.5', '41',   '40.5']],
  [270, ['27',   '9',    '10',   '8',   '8',   '42',   '41']],
  [275, ['27.5', '9.5',  '10.5', '8.5', '8.5', '42.5', '-']],
  [280, ['28',   '10',   '11',   '9',   '9',   '43',   '-']],
  [285, ['28.5', '10.5', '11.5', '9.5', '-',   '44',   '-']],
  [290, ['29',   '11',   '12',   '10',  '-',   '44.5', '-']],
  [295, ['29.5', '11.5', '-',    '10.5','-',   '45',   '-']],
  [300, ['30',   '12',   '-',    '11',  '-',   '45.5', '-']],
  [310, ['31',   '13',   '-',    '12',  '-',   '47',   '-']],
]);

function _buildStandardShoeSizeTable(optionSizes) {
  const rows = [];
  if (optionSizes && optionSizes.length > 0) {
    for (const sizeStr of optionSizes) {
      const mm = parseInt(sizeStr, 10);
      if (isNaN(mm)) continue;
      const values = _SHOE_SIZE_MAP.get(mm);
      if (values) rows.push({ size: String(mm), values: [...values] });
    }
  } else {
    for (const [mm, values] of _SHOE_SIZE_MAP) {
      rows.push({ size: String(mm), values: [...values] });
    }
  }
  return rows.length > 0 ? { headers: [..._SHOE_SIZE_HEADERS], rows, unit: 'mm' } : null;
}

/**
 * actual-size API 호출 → SizeTable + sizeGuideImages 반환
 * API 실패/사이즈 정보 없음이면 null
 */
export async function getSizeInfo(goodsNo) {
  try {
    const resp = await musinsaFetch(
      `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/actual-size`,
      {}, `size info ${goodsNo}`
    );
    const json = await resp.json();
    if (json.meta?.result === 'SUCCESS' && json.data?.sizes?.length > 0) {
      const d = json.data;
      const headers = [];
      for (const size of d.sizes) {
        for (const item of (size.items || [])) {
          if (item?.name && !headers.includes(item.name)) headers.push(item.name);
        }
      }
      if (headers.length === 0) return null;

      const rows = d.sizes.map(s => ({
        size: s.name,
        values: headers.map(header => {
          const matched = (s.items || []).find(it => it?.name === header);
          return matched?.value != null ? String(matched.value) : '';
        }),
      })).filter(row => row.size || row.values.some(Boolean));
      if (rows.length === 0) return null;

      const sizeTable = { headers, rows, unit: 'cm' };

      const guideImages = [];
      for (const key of ['webImage', 'mobileImage']) {
        const raw = d[key];
        if (!raw) continue;
        const img = raw.startsWith('//') ? 'https:' + raw : raw;
        if (!guideImages.includes(img)) guideImages.push(img);
      }

      return { sizeTable, sizeGuideImages: guideImages };
    }
  } catch (e) {
    console.warn('[musinsa] actual-size API failed:', e.message);
  }
  return null;
}

/** 상세 페이지 파싱 */
export async function getDetail(goodsNo, opts = {}) {
  await randomDelay();
  // 2026-06-13 속도: benefit API 는 goodsNo 만 의존(자체 delay 없음) → detail HTML fetch 와 병렬.
  //   상품당 1 round-trip 제거. 정확도 동일(mergeBenefitApiData 순서무관, 같은 상품 페이지+API 동시
  //   요청은 실브라우저 page-load 와 동일 패턴 = anti-bot 위험 미미). data.goodsNo≠입력 드문 경우만 재요청.
  const benefitApiPromise = fetchGoodsBenefitApi(goodsNo).catch(() => null);
  const resp = await musinsaFetch(`https://www.musinsa.com/products/${goodsNo}`, {}, `detail ${goodsNo}`);
  const html = await resp.text();

  // HTML에서 최대혜택가 파싱 — CSR이라 서버 HTML에는 없음 (Content Script에서 별도 처리)
  let htmlBenefitPrice = null;

  const marker = '"__NEXT_DATA__" type="application/json">';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error(`No data for ${goodsNo}`);
  const jsonStr = html.substring(idx + marker.length, html.indexOf('</script>', idx + marker.length));
  const nd = JSON.parse(jsonStr);

  const meta = nd?.props?.pageProps?.meta;
  const data = meta?.data || meta?.meta?.data || {};
  if (!data.goodsNo) throw new Error(`Product ${goodsNo} not found`);
  // 병렬로 받아둔 benefit API 결과 사용. 입력 goodsNo 와 data.goodsNo 가 다른 드문 경우(리다이렉트/
  // 통합상품)만 정확한 번호로 재요청해 정확도 보존.
  let apiBenefitData = await benefitApiPromise;
  if (String(data.goodsNo) !== String(goodsNo)) {
    apiBenefitData = await fetchGoodsBenefitApi(data.goodsNo);
  }
  const benefitSourceData = mergeBenefitApiData(data, apiBenefitData);

  const images = [];
  if (data.thumbnailImageUrl) {
    images.push(data.thumbnailImageUrl.startsWith('http') ? data.thumbnailImageUrl : `https://image.msscdn.net${data.thumbnailImageUrl}`);
  }
  for (const img of (data.goodsImages || [])) {
    const u = img.imageUrl || img.url || '';
    if (u) images.push(u.startsWith('http') ? u : `https://image.msscdn.net${u}`);
  }

  const cat = data.category || {};
  const price = data.goodsPrice || {};
  const specs = {};
  if (data.sex) specs['성별'] = data.sex === 'M' ? '남성용' : data.sex === 'F' ? '여성용' : '남녀공용';
  for (const mat of (data.goodsMaterial?.materials || [])) {
    const sel = (mat.items || []).filter(i => i.isSelected).map(i => i.name);
    if (sel.length === 0) continue;
    if (mat.name === '핏') specs['핏'] = sel[0];
    if (mat.name === '계절') specs['계절'] = sel.join(',');
    if (mat.name === '두께') specs['두께'] = sel[0];
  }

  // 목적: 혜택가 필드 수집 — __NEXT_DATA__ + 쿠폰 API (등급 전용 쿠폰용)
  //   v1.0.3: gp.couponPrice 는 등급쿠폰 미포함 → 쿠폰 API (getUsableCouponsByGoodsNo)
  //   를 호출해서 실제 할인액을 받아온다. 사용자 브라우저 쿠키로 개인화.
  const gpForCoupon = benefitSourceData.goodsPrice || {};
  const salePriceForCoupon = gpForCoupon.salePrice || gpForCoupon.normalPrice || 0;
  const brandForCoupon = benefitSourceData.brand || data.brand || '';
  const comIdForCoupon = benefitSourceData.comId || benefitSourceData.brandInfo?.comId || data.comId || data.brandInfo?.comId || '';

  let couponDiscountFromApi = 0;
  const cartCouponDiscountFromApi = 0;
  const couponDiscountFromDetailApi = !benefitSourceData.isLimitedCoupon
    ? readDetailCouponDiscount(benefitSourceData, salePriceForCoupon)
    : 0;
  if (!benefitSourceData.isLimitedCoupon && salePriceForCoupon > 0) {
    if (couponDiscountFromDetailApi > 0) {
      couponDiscountFromApi = couponDiscountFromDetailApi;
    } else {
      try {
        couponDiscountFromApi = await fetchBestCouponDiscount(data.goodsNo, brandForCoupon, comIdForCoupon, salePriceForCoupon);
      } catch { /* coupon API failure -> 0 fallback */ }
    }
  }
  // Fallback: SSR 에 있던 공개 쿠폰 금액 사용 (로그아웃이거나 쿠폰 API 실패 시)
  if (couponDiscountFromApi === 0 && !benefitSourceData.isLimitedCoupon) {
    couponDiscountFromApi = readDetailCouponDiscount(data, salePriceForCoupon) || 0;
  }

  let benefitData = {};
  function extractBenefit(d) {
    const gp = d.goodsPrice || {};
    const totalCouponDc = couponDiscountFromApi;
    const exactDiscounts = readExactDiscounts(d);
    // v1.1.3 (2026-04-18): 등급할인 불가상품 (isLimitedDc=true) 은 memberDiscountRate 를 0 으로.
    // 무신사 API 가 로그인 상태에서 상품별 제한 flag 와 무관하게 계정 등급률을 반환하는 경우가
    // 있어 UI 가 "등급할인 -XX원 적용됨" 잘못 표시. 사용자 보고: 상품 5985884 (30505)
    // isLimitedDc=true 인데 3% 반영됨.
    const effectiveMemberDiscountRate = d.isLimitedDc ? 0 : (gp.memberDiscountRate || 0);
    const chain = calcMaxBenefitPrice(d, {
      couponDiscount: couponDiscountFromApi,
      cartCouponDiscount: cartCouponDiscountFromApi,
      memberDiscountRate: effectiveMemberDiscountRate,
      memberSavePointRate: gp.memberSavePointRate || 0,
      savePoint: gp.savePoint || 0,
      ...(exactDiscounts.gradeDiscountAmount !== undefined && { gradeDiscountAmount: exactDiscounts.gradeDiscountAmount }),
      ...(exactDiscounts.prePointDiscountAmount !== undefined && { prePointDiscountAmount: exactDiscounts.prePointDiscountAmount }),
    });
    const gradeDiscountAmount = chain.gradeDiscount;
    const prePointDiscountAmount = chain.prePointDiscount;
    const ownPointDiscountAmount = exactDiscounts.ownPointDiscountAmount ?? 0;
    return {
      memberDiscountRate: effectiveMemberDiscountRate,
      memberSavePointRate: gp.memberSavePointRate || 0,
      memberSaveMoneyRate: gp.memberSaveMoneyRate || 0,
      savePoint: gp.savePoint || 0,
      savePointPercent: gp.savePointPercent || 0,
      couponDcPrice: totalCouponDc,
      isPrePoint: !!d.isPrePoint,
      // 백엔드 defense-in-depth — isLimitedDc 를 forward 해서 백엔드 guard 재확인
      isLimitedDc: !!d.isLimitedDc,
      maxUsePointRate: d.maxUsePointRate || 0,
      memberGrade: d.memberGrade || null,
      memberPoint: d.point?.memberPoint || 0,
      benefitPrice: chain.benefitPrice,
      benefitDetails: {
        couponDcPrice: totalCouponDc,
        memberDiscountRate: effectiveMemberDiscountRate,
        memberSavePointRate: gp.memberSavePointRate || 0,
        isLimitedDc: !!d.isLimitedDc,
        savePoint: gp.savePoint || 0,
        isPrePoint: !!d.isPrePoint,
        gradeDiscount: chain.gradeDiscount,
        prePointDiscount: chain.prePointDiscount,
        gradeDiscountAmount,
        prePointDiscountAmount,
        ownPointDiscountAmount,
        benefitSource: apiBenefitData ? 'extension-api' : 'extension-api-fallback',
        memberPoint: d.point?.memberPoint || 0,
        maxUsePointRate: d.maxUsePointRate || 0,
        // v1.1.4 (2026-04-18): 적립금 제한 플래그 저장.
        // 서버 mergeStoredMusinsaBenefitData 가 stored 값으로 memberPoint/maxUsePointRate 를
        // 복구할 때 이 플래그를 보고 0 유지해야 "사용불가 상품" 적립금 차감을 차단할 수 있음.
        isRestrictedUsePoint: !!(d.isRestictedUsePoint || d.isRestrictedUsePoint),
        isLimitedPoint: !!d.isLimitedPoint,
      },
      // 서버 resolveSellPrice 체인 계산용 raw 데이터
      // 제한 플래그 (isLimitedDc, isLimitedCoupon, isLimitedPoint, isRestictedUsePoint) 는
      // 여기서 미리 반영 — 백엔드는 musinsaRaw 숫자 필드만 보고 chain 계산
      musinsaRaw: {
        salePrice: gp.salePrice || gp.normalPrice || 0,
        couponDiscount: d.isLimitedCoupon ? 0 : couponDiscountFromApi,
        cartCouponDiscount: d.isLimitedCoupon ? 0 : cartCouponDiscountFromApi,
        // 등급할인: v1.1.3 에서 복원 — isLimitedDc 만 게이트
        memberDiscountRate: effectiveMemberDiscountRate,
        // v1.0.5: isPrePoint 게이트 제거 — 원시 rate 보존. isLimitedPoint 만 0처리.
        savePoint: gp.savePoint || 0,
        memberSavePointRate: gp.memberSavePointRate || 0,
        memberPoint: (d.isRestictedUsePoint || d.isRestrictedUsePoint) ? 0 : (d.point?.memberPoint || 0),
        maxUsePointRate: (d.isRestictedUsePoint || d.isRestrictedUsePoint) ? 0 : (d.maxUsePointRate || 0),
        isPrePoint: !!d.isPrePoint,
        gradeDiscountAmount,
        prePointDiscountAmount,
        ownPointDiscountAmount,
        benefitSource: apiBenefitData ? 'extension-api' : 'extension-api-fallback',
        isLimitedDc: !!d.isLimitedDc,
        // v1.1.4 (2026-04-18): 서버 MusinsaBenefitRaw 와 일치시키기 위해 원시 플래그 forward.
        // resolveSellPrice 의 defensive ownPoint gate 조건 (!musinsaRaw.isRestrictedUsePoint) 용.
        isRestrictedUsePoint: !!(d.isRestictedUsePoint || d.isRestrictedUsePoint),
        isLimitedPoint: !!d.isLimitedPoint,
      },
    };
  }
  // __NEXT_DATA__ + 쿠폰 API 결과로 혜택 데이터 추출 (로그인 쿠키 포함 시 등급쿠폰 정확)
  benefitData = extractBenefit(benefitSourceData);

  const goodsContentsHtml = data.goodsContents || '';
  const htmlSizeTable = _parseSizeTable(goodsContentsHtml);
  const htmlSizeGuideImages = _extractSizeGuideImages(goodsContentsHtml);
  const apiSizeInfo = data.isUseSize ? await getSizeInfo(data.goodsNo) : null;
  const sizeGuideImages = [...new Set([
    ...(apiSizeInfo?.sizeGuideImages || []),
    ...htmlSizeGuideImages,
  ])];

  // 상품 정보고시 (필수정보) — /essential API
  let productNotices = null;
  try {
    const essResp = await musinsaFetch(`https://goods-detail.musinsa.com/api2/goods/${goodsNo}/essential`, {}, `essential ${goodsNo}`);
    if (essResp.ok) {
      const essJson = await essResp.json();
      if (essJson.meta?.result === 'SUCCESS' && essJson.data?.essentials?.length) {
        productNotices = essJson.data.essentials.map(e => ({ key: e.name, value: e.value }));
      }
    }
  } catch { /* 정보고시 실패 무시 */ }

  // URL 패턴으로 불필요 이미지 제거 (model/outro/intro/lookbook/size) — 항상 적용
  const filteredImages = filterImagesByUrlPattern(images);
  const filteredDetailImages = filterImagesByUrlPattern(extractDetailImages(goodsContentsHtml));

  // 소싱처 배송 소요일 (Phase 2) — 정수 일수.
  // 예약상품 (deliveryDueType === 'RESERVATION') 은 출고일 고정 불가 → null.
  // 2026-04-21 (v1.2.1 재시도): PR #577 기능을 Chrome SW ESM parser 안전 방식으로 복원.
  //   patterns: "평균 출고 N일" + "지금 주문 시 N일" + "MM.DD 도착 예정" + "당일" + "익일/내일".
  //   try/catch 유지 — musinsa.js 는 Chrome V8 에서 parse OK (ssg.js 와 달리).
  let sourceLeadDays = null;
  try {
    if (data.deliveryDueType !== 'RESERVATION') {
      // 2026-04-22 (v1.2.2): 실제 무신사 API 응답 구조 재확인 후 경로 교정.
      //   이전 후보 (deliveryInfo.averageShippingDay, delivery.leadDays 등) 는 API 응답에 없음 →
      //   모든 상품 0% 파싱 (9,748건 / 9,748건 전부 NULL) 버그.
      //   실제 필드: domesticDelivery.willReleaseDate (출고 예정일) + deliveryExpectedArrival[0].expectedDate
      //   (도착 예정일, 오늘+1~+N). 오늘 자정 기준 일수 차이로 환산.
      const nowMidnight = new Date();
      nowMidnight.setHours(0, 0, 0, 0);
      // 2026-04-22 PR-E: 영업일 diff (주말 제외). 사용자 요구 반영.
      //   오늘=수(4/22) + 도착=월(4/27) → 캘린더 diff=5 / 영업일 diff=3 (토/일 제외).
      const businessDaysDiff = (isoDate) => {
        if (typeof isoDate !== 'string') return null;
        const t = Date.parse(isoDate);
        if (!Number.isFinite(t)) return null;
        const target = new Date(t);
        target.setHours(0, 0, 0, 0);
        if (target.getTime() <= nowMidnight.getTime()) return 0;
        let count = 0, loops = 0;
        for (let cursor = nowMidnight.getTime() + 86400000; cursor <= target.getTime() && loops < 60; cursor += 86400000, loops++) {
          const dow = new Date(cursor).getDay();  // 0=일, 6=토
          if (dow !== 0 && dow !== 6) count++;
        }
        return count;
      };
      // 1. willReleaseDate (출고일) — 가장 정확. 영업일 기준.
      //    release 당일이면 영업일=0 → 1 clamp (당일발송).
      const releaseBizDiff = businessDaysDiff(data.domesticDelivery?.willReleaseDate);
      if (releaseBizDiff != null && releaseBizDiff >= 0 && releaseBizDiff <= 30) {
        sourceLeadDays = Math.max(1, releaseBizDiff);
      }
      // 2. willArrivalDate / deliveryExpectedArrival[0].expectedDate fallback (영업일 기준).
      if (sourceLeadDays == null) {
        const arrivalBizDiff = businessDaysDiff(
          data.domesticDelivery?.willArrivalDate
          ?? data.deliveryExpectedArrival?.[0]?.expectedDate
        );
        if (arrivalBizDiff != null && arrivalBizDiff >= 1 && arrivalBizDiff <= 30) {
          sourceLeadDays = arrivalBizDiff;
        }
      }
      // 3. legacy 후보 (존재하지 않는 것으로 확인됐으나 API 변경 대비 유지).
      if (sourceLeadDays == null) {
        const legacyCandidates = [
          data.deliveryInfo?.averageShippingDay,
          data.deliveryInfo?.shippingDays,
          data.delivery?.averageDays,
          data.delivery?.leadDays,
          data.averageShippingDay,
          data.avgShippingDay,
        ];
        for (const c of legacyCandidates) {
          const n = typeof c === 'number' ? c : parseInt(c, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 30) { sourceLeadDays = n; break; }
        }
      }
      if (sourceLeadDays == null && typeof goodsContentsHtml === 'string') {
        // 1. "평균 출고 N일" (v1.1.8 기존)
        let m = goodsContentsHtml.match(/평균\s*출고\s*(\d{1,2})\s*일/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n >= 1 && n <= 30) sourceLeadDays = n;
        }
        // 2. "지금 주문 시 N일" / "주문 후 N일"
        if (sourceLeadDays == null) {
          m = goodsContentsHtml.match(/(?:지금\s*주문\s*시|주문\s*후)\s*(\d{1,2})\s*일/);
          if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 30) sourceLeadDays = n;
          }
        }
        // 3. "MM.DD 도착 예정" / "MM.DD 도착" — 절대 날짜 → 영업일 diff 환산.
        if (sourceLeadDays == null) {
          m = goodsContentsHtml.match(/(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(?:도착|배송|발송|출고)/);
          if (m) {
            const mm = parseInt(m[1], 10);
            const dd = parseInt(m[2], 10);
            if (Number.isFinite(mm) && Number.isFinite(dd) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
              const now = new Date();
              now.setHours(0, 0, 0, 0);
              const target = new Date(now.getFullYear(), mm - 1, dd);
              if (target.getTime() < now.getTime() - 24 * 60 * 60 * 1000) target.setFullYear(now.getFullYear() + 1);
              // 영업일 diff 계산 (주말 제외)
              let bizDiff = 0, loops = 0;
              for (let cursor = now.getTime() + 86400000; cursor <= target.getTime() && loops < 60; cursor += 86400000, loops++) {
                const dow = new Date(cursor).getDay();
                if (dow !== 0 && dow !== 6) bizDiff++;
              }
              if (bizDiff >= 1 && bizDiff <= 30) sourceLeadDays = bizDiff;
            }
          }
        }
        // 4. "당일 발송/출고/배송"
        if (sourceLeadDays == null && /당일\s*(발송|출고|배송)/.test(goodsContentsHtml)) {
          sourceLeadDays = 1;
        }
        // 5. "익일/내일/다음날 배송/도착/출고"
        if (sourceLeadDays == null && /(익일|내일|다음날)\s*(배송|도착|출고)/.test(goodsContentsHtml)) {
          sourceLeadDays = 1;
        }
      }
    }
  } catch { /* null fallback */ }

  // Coupang 2026-08-01 정책 — 품번/상품코드 보강 (specs fallback chain 의 source).
  // 우선순위: data.styleNumber > goodsNo. 둘 다 비어있으면 specs 키 추가 안 함.
  const musinsaStyleNo = String(data.styleNumber || data.styleNo || data.style_no || '').trim();
  if (musinsaStyleNo) specs['품번'] = musinsaStyleNo;
  const musinsaGoodsNo = String(data.goodsNo || '').trim();
  if (musinsaGoodsNo && !specs['상품코드']) specs['상품코드'] = musinsaGoodsNo;

  return {
    goodsNo: data.goodsNo,
    goodsName: data.goodsNm || data.goodsName || '',
    brand: data.brand || '',
    brandName: data.brandInfo?.brandName || '',
    images: filteredImages,
    normalPrice: price.normalPrice || 0,
    salePrice: price.salePrice || price.normalPrice || 0,
    category: [cat.categoryDepth1Name, cat.categoryDepth2Name, cat.categoryDepth3Name].filter(Boolean).join(' > '),
    categoryCode: cat.categoryDepth2Code || cat.categoryDepth1Code || '',
    specs,
    sourceUrl: `https://www.musinsa.com/products/${goodsNo}`,
    // PDP 판매상태: STOP_SALE/SOLDOUT 은 옵션 inventory 수량보다 상위 truth.
    goodsSaleType: data.goodsSaleType || null,
    isOutOfStock: data.isOutOfStock === true,
    sourcePdpSoldout: ['STOP_SALE', 'SOLDOUT'].includes(String(data.goodsSaleType || '').toUpperCase()) || data.isOutOfStock === true,
    sourceOrderable: !(['STOP_SALE', 'SOLDOUT'].includes(String(data.goodsSaleType || '').toUpperCase()) || data.isOutOfStock === true),
    isOfflineGoods: !!data.isOfflineGoods,
    productNotices,
    // 상세 이미지 (goodsContents HTML에서 추출, 모델필터 적용)
    detailImages: filteredDetailImages,
    sizeTable: apiSizeInfo?.sizeTable || htmlSizeTable
      // 신발 기준표 사이즈 fallback — actual-size/HTML 모두 없을 때
      || ((data.optKindCd === 'SHOES' || cat.categoryDepth1Name === '신발') ? _buildStandardShoeSizeTable() : null),
    sizeGuideImages,
    ...benefitData,
    // HTML에서 파싱 못하면 API 계산값 사용. Content Script는 collect()에서 별도 호출
    ...(htmlBenefitPrice && { benefitPrice: htmlBenefitPrice }),
    // Phase 2: 소싱처 배송 소요일 — null-safe (못 찾으면 정책 fallback).
    ...(sourceLeadDays != null && { sourceLeadDays }),
  };
}

/** 옵션 + 재고 */
export async function getOptions(goodsNo) {
  await randomDelay();
  const resp = await musinsaFetch(`https://goods-detail.musinsa.com/api2/goods/${goodsNo}/options`, {}, `options ${goodsNo}`);
  const json = await resp.json();
  if (json.meta?.result !== 'SUCCESS') throw new Error(`Options failed for ${goodsNo}`);

  const optionValueNos = [];
  for (const basic of (json.data?.basic || [])) {
    for (const ov of (basic.optionValues || [])) {
      if (ov.no) optionValueNos.push(ov.no);
    }
  }

  // 재고 조회
  const stockMap = new Map();
  if (optionValueNos.length > 0) {
    try {
      const sResp = await musinsaFetch(
        `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/options/v2/prioritized-inventories`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionValueNos }) },
        `inventory ${goodsNo}`,
      );
      const sJson = await sResp.json();
      if (sJson.meta?.result === 'SUCCESS' && Array.isArray(sJson.data)) {
        // remainQuantity: null=충분, 숫자=소량, 0=품절 — outOfStock일 때는 0으로 정규화
        for (const item of sJson.data) {
          const outOfStock = item.outOfStock === true;
          const remainQuantity = outOfStock
            ? 0
            : (typeof item.remainQuantity === 'number' ? item.remainQuantity : null);
          stockMap.set(item.productVariantId, { outOfStock, remainQuantity });
        }
      }
    } catch {}
  }

  return (json.data?.optionItems || []).map(item => {
    const vals = item.optionValues || [];
    const stockInfo = stockMap.get(item.no);
    return {
      name: vals.map(v => v.name).join('/') || item.managedCode || '',
      optionName: vals[0]?.optionName || 'size',
      price: item.price || 0,
      activated: item.activated !== false,
      outOfStock: stockInfo?.outOfStock ?? false,
      remainQuantity: stockInfo?.remainQuantity ?? null,
      managedCode: item.managedCode || '',
    };
  });
}

/**
 * 전체 수집 흐름
 * @param {string} url - 무신사 URL
 * @param {number} limit - 최대 수집 수
 * @param {function} onProgress - (progress, collected, total) => void
 * @returns {Array} 수집된 상품 목록
 */
export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  console.log('[BulkFlow][Musinsa] collect v1.0.1 — remainQuantity 기반 재고 (하드코딩 1 수정됨)');
  const searchParams = parseUrl(url);
  const seenIds = new Set();
  const allGoods = [];

  await onProgress(0, 0, 0, '검색 중...');
  console.log('[BulkFlow] 수집 시작:', { url, limit, searchParams });

  // 카테고리 URL이면 가격대 세분화, 검색/브랜드 URL이면 페이지네이션
  const isCategory = searchParams.category1DepthCode || searchParams.category2DepthCode;
  const needsPriceSegment = isCategory && !searchParams.keyword;

  if (needsPriceSegment) {
    // 카테고리: 가격대 세분화 (page 2+ 403 우회)
    console.log('[BulkFlow] 가격대 세분화 모드');
    const ranges = [];
    for (let p = 0; p < 60000; p += 1000) ranges.push([p, p + 1000]);
    for (let p = 60000; p < 100000; p += 2000) ranges.push([p, p + 2000]);
    for (let p = 100000; p < 200000; p += 5000) ranges.push([p, p + 5000]);
    ranges.push([200000, 500000]);

    for (const [minPrice, maxPrice] of ranges) {
      if (allGoods.length >= limit) break;
      try {
        await randomDelay();
        const result = await searchProducts({ ...searchParams, page: 1, size: 60, minPrice, maxPrice });
        console.log(`[BulkFlow] 가격 ${minPrice}-${maxPrice}: ${result.list.length}개`);
        for (const item of result.list) {
          if (!seenIds.has(item.goodsNo)) {
            seenIds.add(item.goodsNo);
            allGoods.push(item);
          }
        }
      } catch (e) { console.error(`[BulkFlow] 가격대 검색 실패:`, e.message); }
      await onProgress(Math.min(30, Math.round((allGoods.length / limit) * 30)), allGoods.length, 0, `검색 중... ${allGoods.length}개 발견`);
    }
  } else {
    // 검색/브랜드: 일반 페이지네이션 (1페이지만 — 2+ 403)
    console.log('[BulkFlow] 일반 검색 모드');
    try {
      const result = await searchProducts({ ...searchParams, page: 1, size: 60 });
      console.log(`[BulkFlow] 검색 결과: ${result.list.length}개 / 총 ${result.totalCount}개`);
      for (const item of result.list) {
        if (!seenIds.has(item.goodsNo)) {
          seenIds.add(item.goodsNo);
          allGoods.push(item);
        }
      }
    } catch (e) { console.error('[BulkFlow] 검색 실패:', e.message); }

    // 검색으로 60개 초과 필요시 가격대 세분화 추가
    if (allGoods.length < limit && allGoods.length > 0) {
      console.log('[BulkFlow] 추가 수집: 가격대 세분화');
      const ranges = [];
      for (let p = 0; p < 60000; p += 1000) ranges.push([p, p + 1000]);
      for (let p = 60000; p < 100000; p += 2000) ranges.push([p, p + 2000]);
      for (let p = 100000; p < 200000; p += 5000) ranges.push([p, p + 5000]);
      ranges.push([200000, 500000]);

      for (const [minPrice, maxPrice] of ranges) {
        if (allGoods.length >= limit) break;
        try {
          await randomDelay();
          const result = await searchProducts({ ...searchParams, page: 1, size: 60, minPrice, maxPrice });
          for (const item of result.list) {
            if (!seenIds.has(item.goodsNo)) { seenIds.add(item.goodsNo); allGoods.push(item); }
          }
        } catch {}
      }
    }

    await onProgress(Math.min(30, Math.round((allGoods.length / limit) * 30)), allGoods.length, 0, `검색 중... ${allGoods.length}개 발견`);
  }

  console.log(`[BulkFlow] 검색 완료: 총 ${allGoods.length}개 발견`);

  const STREAM_BATCH = 50;
  const toCollect = allGoods.slice(0, limit);
  const products = [];
  const pendingBatch = []; // 스트리밍 전송 대기 버퍼
  let collected = 0;

  console.log(`[BulkFlow] ${toCollect.length}개 상품 상세 수집 시작`);
  await onProgress(30, toCollect.length, 0, `${toCollect.length}개 상품 수집 시작`);

  for (const goods of toCollect) {
    try {
      let detail = null;
      try { detail = await getDetail(goods.goodsNo); } catch (e) { console.warn(`[BulkFlow] 상세 실패 ${goods.goodsNo}:`, e.message); }

      if (detail?.isOfflineGoods) continue;

      const opts = await getOptions(goods.goodsNo);
      // MAX_STOCK cap: 10 (백엔드와 동일)
      // remainQuantity: null=충분(→10) / 숫자=소량(그대로) / outOfStock/!activated=0
      const MAX_STOCK = 10;
      const rawTotal = opts.reduce((sum, o) => {
        if (o.outOfStock || !o.activated) return sum;
        return sum + (o.remainQuantity != null ? o.remainQuantity : MAX_STOCK);
      }, 0);
      const totalStock = Math.min(rawTotal, MAX_STOCK);
      const isSoldOut = goods.isSoldOut || rawTotal === 0;

      products.push({
        sourceMarket: 'musinsa',
        sourceId: String(goods.goodsNo),
        sourceUrl: `https://www.musinsa.com/products/${goods.goodsNo}`,
        brand: goods.brand,
        // v1.1.5 (2026-04-18): 무신사 brandInfo.brandName (한글) 도 함께 전송.
        // 서버 /collect/receive 가 `{brandName} {brand}` 조합으로 DB 저장 → 쿠팡/네이버
        // 업로드 시 한글 병기가 자동 적용. BRAND_KR_TO_EN 매핑에 없는 브랜드도 커버.
        brandName: goods.brandName || '',
        originalTitle: goods.goodsName,
        originalPrice: goods.normalPrice,
        sellPrice: goods.couponPrice || goods.price,
        couponPrice: goods.couponPrice,
        categorySource: detail?.category || '',
        images: detail?.images || [goods.thumbnail],
        specs: detail?.specs || {},
        options: opts.map(o => ({
          optionName: o.name,
          optionType: o.optionName,
          sku: o.managedCode,
          // remainQuantity: null=충분(→MAX_STOCK) / 숫자=실재고 / outOfStock/!activated=0
          stock: o.outOfStock
            ? 0
            : (!o.activated
                ? 0
                : Math.min(o.remainQuantity != null ? o.remainQuantity : MAX_STOCK, MAX_STOCK)),
          isSoldout: o.outOfStock || !o.activated,
          priceDiff: o.price,
        })),
        totalStock,
        isSoldout: isSoldOut,
        // 목적: 혜택가 및 혜택 상세 (등급할인, 적립금, 선할인, 쿠폰) — optional
        ...(detail?.benefitPrice != null && { benefitPrice: detail.benefitPrice }),
        ...(detail?.benefitDetails && { benefitDetails: detail.benefitDetails }),
        ...(detail?.memberGrade && { memberGradeLevel: detail.memberGrade?.level }),
        // 혜택 세부 필드 (DB 컬럼 직접 매핑)
        ...(detail?.couponDcPrice != null && { couponDcPrice: detail.couponDcPrice }),
        ...(detail?.isPrePoint != null && { isPrePoint: detail.isPrePoint }),
        ...(detail?.savePoint != null && { savePoint: detail.savePoint }),
        ...(detail?.memberDiscountRate != null && { memberDiscountRate: detail.memberDiscountRate }),
        ...(detail?.memberSavePointRate != null && { memberSavePointRate: detail.memberSavePointRate }),
        ...(detail?.memberSaveMoneyRate != null && { memberSaveMoneyRate: detail.memberSaveMoneyRate }),
        // 서버 resolveSellPrice 체인 계산용
        ...(detail?.musinsaRaw && { musinsaRaw: detail.musinsaRaw }),
        // 상품 정보고시
        ...(detail?.productNotices != null && { productNotices: detail.productNotices }),
        // 상세 이미지 (brand rule 필터 적용)
        ...(detail?.detailImages?.length > 0 && { detailImages: detail.detailImages }),
        // 사이즈표 + 사이즈 가이드 이미지
        ...(detail?.sizeTable != null && { sizeTable: detail.sizeTable }),
        ...(detail?.sizeGuideImages?.length > 0 && { sizeGuideImages: detail.sizeGuideImages }),
        // 2026-04-22 PR-D followup: 출고소요일 (v1.2.2 willReleaseDate 기반).
        //   대량 수집 경로 payload 누락 hotfix — 이전에는 getDetail() 이 계산했지만
        //   products.push({...}) 안에 spread 안돼서 서버에 전달 안 됐음.
        //   단건 push (musinsa-sync-push.js) 는 PR #594 에서 이미 추가됨.
        ...(detail?.sourceLeadDays != null && { sourceLeadDays: detail.sourceLeadDays }),
      });

      collected++;
      pendingBatch.push(products[products.length - 1]);

      // 50개마다 스트리밍 전송
      if (pendingBatch.length >= STREAM_BATCH && options.onBatch) {
        try {
          await options.onBatch([...pendingBatch]);
          pendingBatch.length = 0;
        } catch (e) { console.error('[BulkFlow] 스트리밍 전송 실패:', e.message); }
      }

      const progress = 30 + Math.round((collected / toCollect.length) * 70);
      await onProgress(progress, toCollect.length, collected, `${collected}/${toCollect.length} 수집중`);
    } catch (err) {
      console.error(`[BulkFlow] Error ${goods.goodsNo}:`, err.message);
    }
  }

  // 나머지 전송
  if (pendingBatch.length > 0 && options.onBatch) {
    try { await options.onBatch([...pendingBatch]); } catch {}
  }

  await onProgress(100, toCollect.length, collected, '수집 완료');
  return products;
}
