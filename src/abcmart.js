// 목적: ABC마트 (abcmart.a-rt.com / grandstage.co.kr) collector — Phase 1 PoC
//
// 정찰 결과: docs/overnight-20260428/09-new-sources-recon.md (PoC fixture: __tests__/__fixtures__/abcmart/)
//   - robots.txt: Allow / (가장 자유, ClaudeBot/모든 봇 명시 허용)
//   - 비로그인 fetch — 인증 / 쿠키 불필요
//   - 핵심 데이터 endpoint 2개:
//       1) GET /display/search-word/result-total/list?searchWord=K&page=N&perPage=30&channel=10001&tabGubun=total
//          → { SEARCH: [{ PRDT_NO, PRDT_NAME, BRAND_NAME, NRMAL_AMT, PRDT_DC_PRICE,
//                         PRDT_IMAGE_URL, SIZE_LIST, STYLE_INFO, SOLD_OUT, ... }, ...] }
//       2) GET /product/info?prdtNo=N
//          → { prdtNo, prdtName, engPrdtName, brand: { brandName, brandEnName },
//              productPrice: { normalAmt, sellAmt, empAmt, ... },
//              productOption: [{ prdtOptnNo, optnName, totalStockQty, orderPsbltQty, sellStatCode }, ...],
//              productImage[], productImageExtra[], coupon[], dailyDlvyYn, dawnDlvyYn, ... }
//   - PDP URL: /product?prdtNo=... (canonical: /product/new?prdtNo=...)
//
// rate-limiter (확장 client-side):
//   - 분당 30req 이내 (=2초/req) — 09-new-sources-recon.md 권장 100-200ms 보다 보수적
//   - 차단 시 increment delay + 5초 cooldown
//
// 출력 product shape: lotteon.js 의 parseItem 과 동일 — sourceMarket: 'abcmart'.
// SourceFetcher 인터페이스 호환: parseUrl/searchProducts/getDetail/getOptions/getLeadDays/collect/cleanupAbcmartTab.

// ─── 상수 ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://abcmart.a-rt.com';
const SEARCH_URL = `${BASE_URL}/display/search-word/result-total/list`;
const DETAIL_URL = `${BASE_URL}/product/info`;
const PDP_URL_PREFIX = `${BASE_URL}/product?prdtNo=`;
const PER_PAGE = 30;
const MAX_PAGES = 100; // 30 × 100 = 3000 건 상한 — 검색당
// 분당 30req = 2000ms/req. 09 doc 의 100-200ms 권장보다 보수적.
const FETCH_DELAY_MS = 2000;
const STREAM_BATCH = 50;

// ABC마트 채널: 10001 = ABC-MART, 10002 = grandstage
const DEFAULT_CHANNEL = '10001';

// 판매상태 코드 — 10001 = 판매중. 그 외 (단종/품절/대기) 는 isSoldout 판정.
const SELL_STAT_AVAILABLE = '10001';

// User-Agent — extension service worker 에서 fetch 시 자동 부여되지만, 일관 lookup 용.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─── rate-limiter (간단 큐) ──────────────────────────────────────────────────

let _lastFetchAt = 0;
let _consecutiveBlocks = 0;

// 2026-06-12: 적응형 AIMD + cliff 메모리. 기존 고정 2000ms 는 사이트 권장(100-200ms)보다
//   10× 보수적이라 1만 건이 ~5.5h. 차단(429/403) 0 이면 바닥까지 자가 가속, 차단 신호엔
//   즉시 ×2 백오프 + 차단난 딜레이를 기억(cliff)해 그 위로만 회복 → 같은 한계 재타격 방지.
//   차단 회피가 아니라 "차단되지 않는 최대 지속률" 탐색. SW 재시작 시 2000ms 안전값에서 재학습.
const ABC_DELAY_FLOOR_MS = 400;     // 권장 100-200ms 보다 보수적인 하한
const ABC_DELAY_MAX_MS = 16_000;
const ABC_SPEED_UP_EVERY = 5;       // 성공 5회마다 ×0.85 가속
const ABC_FLOOR_MARGIN = 1.25;      // 차단난 딜레이보다 25% 여유로 바닥 설정
const ABC_FLOOR_DECAY = 0.95;       // 오래 깨끗하면 바닥 완화 재탐색
let _abcDelayMs = FETCH_DELAY_MS;          // 현재 적응 딜레이 (시작=2000 보수)
let _abcSafeFloorMs = ABC_DELAY_FLOOR_MS;  // 학습된 안전 바닥 (cliff 바로 위)
let _abcSuccessStreak = 0;

function markAbcBlocked() {
  _consecutiveBlocks++;
  // 차단난 딜레이 = 더 빠르면 안 되는 한계 → 바닥을 그보다 25% 여유로 끌어올림.
  _abcSafeFloorMs = Math.min(ABC_DELAY_MAX_MS, Math.max(_abcSafeFloorMs, Math.floor(_abcDelayMs * ABC_FLOOR_MARGIN)));
  _abcDelayMs = Math.min(ABC_DELAY_MAX_MS, Math.max(ABC_DELAY_FLOOR_MS, Math.floor(_abcDelayMs * 2)));
  _abcSuccessStreak = 0;
}

function markAbcSuccess() {
  _consecutiveBlocks = 0;
  if (++_abcSuccessStreak < ABC_SPEED_UP_EVERY) return;
  _abcSuccessStreak = 0;
  const next = Math.max(_abcSafeFloorMs, Math.floor(_abcDelayMs * 0.85));
  if (next < _abcDelayMs) {
    _abcDelayMs = next;   // 학습된 안전 바닥까지만 가속
  } else if (_abcSafeFloorMs > ABC_DELAY_FLOOR_MS) {
    // 이미 바닥, 한참 깨끗 → 바닥을 조금 풀어 더 빠른 지점 재탐색.
    _abcSafeFloorMs = Math.max(ABC_DELAY_FLOOR_MS, Math.floor(_abcSafeFloorMs * ABC_FLOOR_DECAY));
    _abcDelayMs = Math.max(_abcSafeFloorMs, Math.floor(_abcDelayMs * 0.92));
  }
}

/** 마지막 fetch 후 적응 딜레이(_abcDelayMs) 경과 보장. */
async function throttle() {
  const now = Date.now();
  const elapsed = now - _lastFetchAt;
  if (elapsed < _abcDelayMs) {
    await new Promise((r) => setTimeout(r, _abcDelayMs - elapsed));
  }
  _lastFetchAt = Date.now();
}

/**
 * rate-limited fetch + JSON 파싱 + 재시도.
 * 2026-04-29 Codex (PR #853 MEDIUM): signal end-to-end wire — fetch() 에 직접 전달
 * 해서 in-flight request 까지 즉시 abort. 기존엔 loop 사이에서만 체크하던 lag (~100s)
 * 해소.
 *
 * @param {string} url
 * @param {{ retries?: number, signal?: AbortSignal }} opts
 */
async function fetchJson(url, opts = {}) {
  const retries = opts?.retries ?? 2;
  const signal = opts?.signal;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new Error('aborted');
    await throttle();
    if (signal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': USER_AGENT,
        },
        signal,
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 403) && i < retries) {
          markAbcBlocked();   // ×2 백오프 + cliff 기억
          console.warn(`[ABC마트] ${res.status} 차단 → delay=${_abcDelayMs}ms(floor ${_abcSafeFloorMs}ms), ${5 * (i + 1)}초 대기 후 재시도`);
          await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      // 성공 → 적응 가속 (5회마다 ×0.85, 바닥까지)
      markAbcSuccess();
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        // ABC마트 가 일부 에러를 HTML 로 반환 — 200 + HTML 도 실패 처리
        throw new Error(`HTML 응답 수신 (content-type: ${contentType})`);
      }
      return await res.json();
    } catch (err) {
      if (i >= retries) throw err;
      console.warn(`[ABC마트] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ─── URL 파싱 ───────────────────────────────────────────────────────────────

/**
 * 검색 URL → 키워드/페이지/채널 추출.
 * 지원 패턴:
 *   - https://abcmart.a-rt.com/display/search-word/result?searchWord=K
 *   - https://abcmart.a-rt.com/display/search-word/?searchPageGubun=product&searchWord=K
 *   - 그 외 searchWord 또는 q 쿼리 파라미터
 *
 * @param {string} url
 * @returns {{ keyword: string, page: number, channel: string }}
 */
export function parseUrl(url) {
  const params = { keyword: '', page: 1, channel: DEFAULT_CHANNEL };
  if (!url || typeof url !== 'string') return params;
  try {
    const u = new URL(url);
    params.keyword = u.searchParams.get('searchWord') || u.searchParams.get('q') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    if (Number.isFinite(page) && page > 0) params.page = page;
    // grandstage.a-rt.com → 채널 10002 (실 도메인 확인: chnnlImageList).
    // .co.kr alias 는 live 에서 DNS/TLS 실패하지만 substring 매칭은 유지 — 사용자가 양쪽 입력 가능.
    if (u.hostname.includes('grandstage')) {
      params.channel = '10002';
    }
  } catch {
    // URL 파싱 실패 → keyword 로 사용
    params.keyword = url;
  }
  return params;
}

// ─── 검색 ───────────────────────────────────────────────────────────────────

/**
 * 검색 결과 1페이지 fetch.
 * @param {{ keyword: string, page?: number, channel?: string, perPage?: number, signal?: AbortSignal }} params
 * @returns {Promise<{ items: Array<any>, totalCount: number }>}
 */
export async function searchProducts(params) {
  const keyword = params?.keyword || '';
  if (!keyword) return { items: [], totalCount: 0 };
  const page = params?.page ?? 1;
  const channel = params?.channel || DEFAULT_CHANNEL;
  const perPage = params?.perPage || PER_PAGE;

  const qs = new URLSearchParams({
    searchWord: keyword,
    tabGubun: 'total',
    page: String(page),
    perPage: String(perPage),
    pageColumn: '3',
    channel,
  });
  const url = `${SEARCH_URL}?${qs}`;

  const data = await fetchJson(url, { signal: params?.signal });
  const items = Array.isArray(data?.SEARCH) ? data.SEARCH : [];
  // GROUP_COUNT_CHNNL_NO[channel] 가 해당 채널의 총 상품수
  const totalCount = Number(data?.GROUP_COUNT_CHNNL_NO?.[channel] ?? 0) || items.length;
  return { items, totalCount };
}

// ─── 상세 ───────────────────────────────────────────────────────────────────

/**
 * 상품 상세 정보 fetch — /product/info 엔드포인트.
 * @param {string} prdtNo
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} 정규화 전 raw detail
 */
export async function getDetail(prdtNo, opts = {}) {
  if (!prdtNo) throw new Error('prdtNo 필수');
  // 2026-05-19: grandstage (channel=10002) 는 host=grandstage.a-rt.com 사용 (abcmart endpoint
  // 는 grandstage prdtNo 거부). schema 는 동일 (X-Requested-With 헤더로 동작).
  const host = opts?.channel === '10002' ? 'https://grandstage.a-rt.com' : BASE_URL;
  const url = `${host}/product/info?prdtNo=${encodeURIComponent(prdtNo)}`;
  return await fetchJson(url, { signal: opts?.signal });
}

/**
 * 상품 옵션 (사이즈별 재고) 추출 — getDetail 결과의 productOption 배열을 정규화.
 * @param {any} detail   getDetail 결과
 * @returns {Array<{ optionName: string, optionType: string, sku: string, stock: number, isSoldout: boolean, priceDiff: number }>}
 */
export function getOptions(detail) {
  const options = Array.isArray(detail?.productOption) ? detail.productOption : [];
  if (options.length === 0) {
    // 옵션 없음 (단일 상품 등) — FREE 1개로 정규화
    return [
      { optionName: 'FREE', optionType: 'none', sku: detail?.prdtNo || '', stock: 0, isSoldout: true, priceDiff: 0 },
    ];
  }
  return options.map((opt) => {
    const stock = Number(opt?.orderPsbltQty ?? opt?.totalStockQty ?? 0) || 0;
    const sellStat = String(opt?.sellStatCode ?? '');
    const isSoldout = sellStat !== SELL_STAT_AVAILABLE || stock <= 0;
    const priceDiff = Number(opt?.optionPrice?.optnAddAmt ?? 0) || 0;
    return {
      optionName: String(opt?.optnName ?? ''),
      optionType: 'size',
      sku: String(opt?.vndrPrdtNoText ?? opt?.prdtOptnNo ?? ''),
      stock,
      isSoldout,
      priceDiff,
    };
  });
}

/**
 * 출고 소요일 추정 — dailyDlvyYn = 'Y' 면 당일배송 가능 → 1일.
 * 그 외 표준 1-3일 출고 (보수적 1일 default).
 * @param {any} detail   getDetail 결과
 * @returns {number} leadDays
 */
export function getLeadDays(detail) {
  // 09 doc Section 4.B.4 — "평균 1-3일 출고" + 당일배송 옵션
  if (detail?.dailyDlvyYn === 'Y' || detail?.dawnDlvyYn === 'Y') return 1;
  return 1; // ABC마트 평균. 단종/입고대기는 sellStatCode 로 별도 판정
}

// ─── 결과 정규화 ─────────────────────────────────────────────────────────────

/**
 * 검색 항목 + 상세 → 표준 product 객체.
 * 출력 shape 는 lotteon.js parseItem 과 동일 (sourceMarket 만 'abcmart').
 *
 * @param {any} searchItem  /display/search-word/result-total/list SEARCH[i]
 * @param {any} detail      /product/info 결과 (or null — 상세 fetch 실패 시 검색 데이터로만 구성)
 * @returns {object} 표준 product
 */
export function parseItem(searchItem, detail = null, opts = {}) {
  const prdtNo = String(searchItem?.PRDT_NO ?? detail?.prdtNo ?? '');
  // 검색 데이터 fallback
  const searchName = String(searchItem?.PRDT_NAME ?? '');
  const searchEngName = String(searchItem?.ENG_PRDT_NAME ?? '');
  const searchBrand = String(searchItem?.BRAND_NAME ?? '');
  const searchImage = String(searchItem?.PRDT_IMAGE_URL ?? '');
  const searchNormalAmt = Number(searchItem?.NRMAL_AMT ?? 0) || 0;
  const searchSellAmt = Number(searchItem?.PRDT_DC_PRICE ?? searchNormalAmt) || 0;

  // 상세 데이터 우선
  const name = String(detail?.prdtName ?? searchName);
  const engName = String(detail?.engPrdtName ?? searchEngName);
  const brand = String(detail?.brand?.brandName ?? searchBrand);
  const brandEn = String(detail?.brand?.brandEnName ?? '');
  const styleInfo = String(detail?.styleInfo ?? searchItem?.STYLE_INFO ?? '');

  // 가격: detail.productPrice 우선, search 값 fallback.
  const price = detail?.productPrice || {};
  const normalAmt = Number(price.normalAmt ?? searchNormalAmt) || 0;
  const sellAmt = Number(price.sellAmt ?? searchSellAmt) || 0;
  // 2026-04-29 Codex (PR #853 MEDIUM): empAmt 는 임직원가 (일반 대중 미적용) 이므로
  // benefitPrice 로 노출하지 않는다. 공식 ABC회원가 endpoint 별도 도입 시 재매핑.

  // 쿠폰 자동할인 — coupon[].dscntAmt 의 max (== maxBenefitCoupon[0].dscntAmt) 를 couponPrice 로.
  // ABC마트 쿠폰은 normalCpnYn='Y' 면 모든 회원 자동 적용 (다운로드 불필요).
  const coupons = Array.isArray(detail?.coupon) ? detail.coupon : [];
  const autoCoupons = coupons.filter((c) => c?.normalCpnYn === 'Y');
  const bestCouponDiscount = autoCoupons.reduce(
    (max, c) => Math.max(max, Number(c?.dscntAmt ?? 0) || 0),
    0,
  );
  const couponDerivedPrice = bestCouponDiscount > 0
    ? Math.max(0, sellAmt - bestCouponDiscount)
    : 0;

  // 이미지: productImageExtra (메인 + 추가 다수) 우선, 없으면 productImage, 없으면 search 썸네일.
  const imagesFromDetail = [
    ...(Array.isArray(detail?.productImage) ? detail.productImage : []),
    ...(Array.isArray(detail?.productImageExtra) ? detail.productImageExtra : []),
  ]
    .map((x) => String(x?.imageUrl || ''))
    .filter((s) => s.startsWith('http'));
  // dedup 보존순서
  const uniqueImages = [];
  const seenImages = new Set();
  for (const img of imagesFromDetail) {
    if (!seenImages.has(img)) {
      seenImages.add(img);
      uniqueImages.push(img);
    }
  }
  const images = uniqueImages.length > 0 ? uniqueImages : (searchImage ? [searchImage] : []);
  const thumbnail = images[0] || '';

  // 옵션 / 재고
  const options = detail ? getOptions(detail) : [];
  const totalStock = options.reduce((sum, o) => sum + (o.stock || 0), 0);
  // isSoldout: search 의 SOLD_OUT='y' 또는 모든 옵션 품절 또는 sellStatCode 비활성
  const searchSoldout = String(searchItem?.SOLD_OUT ?? '').toLowerCase() === 'y';
  const detailSoldout = detail
    ? String(detail.sellStatCode ?? '') !== SELL_STAT_AVAILABLE
    : false;
  const isSoldout = detailSoldout || searchSoldout || (options.length > 0 && options.every((o) => o.isSoldout));

  // 카테고리 — search 의 SY_CTGR_NO (단계 > 단계 > 단계 형식, 마지막 단계가 leaf) 우선
  const categorySource = String(
    detail?.stdrCtgrNo ??
    detail?.stdCtgrNo ??
    String(searchItem?.SY_CTGR_NO ?? '').split('>').pop()?.trim() ?? '',
  );

  // sourceLeadDays
  const sourceLeadDays = detail ? getLeadDays(detail) : null;

  // 2026-05-19: channel=10002 (grandstage) 면 sourceMarket='grandstage' 로 분리 emit.
  // collect.ts SOURCE_HOSTS 가 abcmart/grandstage 별도 등록 (PR 동반). UI 카드 분리.
  const sourceMarket = opts?.channel === '10002' ? 'grandstage' : 'abcmart';
  return {
    sourceMarket,
    sourceId: prdtNo,
    sourceUrl: `${PDP_URL_PREFIX}${prdtNo}`,
    brand,
    originalTitle: name,
    originalPrice: normalAmt,
    sellPrice: sellAmt,
    couponPrice: couponDerivedPrice,
    discount: Number(detail?.displayDiscountRate ?? searchItem?.DISCOUNT_RATE ?? 0) || 0,
    categorySource,
    thumbnail,
    images,
    specs: {
      ...(engName ? { engName } : {}),
      ...(brandEn ? { brandEn } : {}),
      ...(styleInfo ? { styleInfo } : {}),
    },
    options,
    totalStock,
    isSoldout,
    reviewScore: 0, // ABC마트 별점 평균 endpoint 별도 — Phase 1 미수집
    reviewCount: Number(searchItem?.RVW_COUNT ?? 0) || 0,
    storeName: 'ABC마트',
    todayArrive: detail?.dailyDlvyYn === 'Y' || detail?.dawnDlvyYn === 'Y',
    // 2026-04-29 Codex (PR #853 MEDIUM): empAmt 임직원가 mis-mapping 제거. 공식
    // ABC회원가 / 카드 혜택가 endpoint 는 Phase 2 에서 추가.
    benefitPrice: null,
    cardBenefitPrice: null,                           // 카드 즉시할인 endpoint 별도 — Phase 1 미수집
    benefitDetails: null,
    productNotices: null,
    // 2026-04-29 Codex (PR #853 HIGH): 실 ABC마트 detail 은 dlvyAmt (배송비 정수원),
    // freeDlvyStdrAmt (무료배송 기준액) 를 별도 필드로 제공. 기존 'shippingFee: 0' 은
    // freeDlvyYn='N' 케이스에서 잘못된 0 fabricate. dlvyAmt 가 number 면 그대로 반영.
    // detail 없으면 'free' 가정 (검색만으로는 배송정책 불명 — 기존 lotteon parseItem 과 일치).
    shippingType: !detail ? 'free' : (detail.freeDlvyYn === 'Y' ? 'free' : 'paid'),
    shippingFee: !detail ? 0 : (detail.freeDlvyYn === 'Y' ? 0 : (Number(detail.dlvyAmt ?? 0) || 0)),
    sourceLeadDays,
  };
}

// ─── 메인 collect ────────────────────────────────────────────────────────────

/**
 * ABC마트 검색→수집 메인 진입점.
 * @param {string} url           검색 URL
 * @param {number} limit         최대 수집 건수
 * @param {Function} onProgress  진행률 콜백 (percent, total, sent, message)
 * @param {object} options       { onBatch, signal }
 * @returns {Promise<Array<object>>} 수집된 product 배열
 */
export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  const { keyword, channel } = parsed;

  if (!keyword) {
    console.error('[BulkFlow ABC마트] 키워드 없음:', url);
    return [];
  }

  console.log('[BulkFlow ABC마트] 수집 시작:', { keyword, channel, limit });
  onProgress(0, 0, 0, 'ABC마트 검색중...');

  // ── 1단계: 검색 결과 페이지네이션 ──
  const searchItems = [];
  const seenPrdtNos = new Set();
  let totalCount = 0;
  let totalSent = 0;

  for (let page = parsed.page || 1; page <= MAX_PAGES; page++) {
    if (searchItems.length >= limit) break;
    if (options?.signal?.aborted) break;

    let resp;
    try {
      resp = await searchProducts({ keyword, page, channel, signal: options?.signal });
    } catch (err) {
      console.error(`[BulkFlow ABC마트] 검색 페이지 ${page} 실패:`, err.message);
      break;
    }

    if (resp.totalCount && !totalCount) totalCount = resp.totalCount;
    if (!resp.items.length) break;

    let newOnPage = 0;
    for (const it of resp.items) {
      const id = String(it?.PRDT_NO ?? '');
      if (!id || seenPrdtNos.has(id)) continue;
      seenPrdtNos.add(id);
      searchItems.push(it);
      newOnPage++;
      if (searchItems.length >= limit) break;
    }

    const progress = Math.min(20, Math.round((searchItems.length / limit) * 20));
    onProgress(
      progress, totalCount, searchItems.length,
      `검색: ${searchItems.length}/${Math.min(limit, totalCount || limit)}`,
    );

    if (newOnPage === 0) break; // 더 이상 신규 없음 (마지막 페이지 도달)
    if (resp.items.length < PER_PAGE) break;
  }

  if (searchItems.length === 0) {
    onProgress(100, 0, 0, '검색 결과 없음');
    return [];
  }

  console.log(`[BulkFlow ABC마트] 검색 완료: ${searchItems.length}개 → ${STREAM_BATCH}개씩 상세 처리`);

  // ── 2단계: STREAM_BATCH 단위 상세 + 정규화 + 서버 전송 ──
  const allProducts = [];

  for (let batchStart = 0; batchStart < searchItems.length; batchStart += STREAM_BATCH) {
    if (options?.signal?.aborted) break;
    const batchItems = searchItems.slice(batchStart, batchStart + STREAM_BATCH);
    const batchNum = Math.floor(batchStart / STREAM_BATCH) + 1;
    const totalBatches = Math.ceil(searchItems.length / STREAM_BATCH);

    console.log(`[BulkFlow ABC마트] 배치 ${batchNum}/${totalBatches}: ${batchItems.length}개 처리중`);

    // 상세 — 직렬 (rate-limiter 가 분당 30 자체 제어). 차단 0 보장이 동시성 이득보다 중요.
    const batchProducts = [];
    for (const item of batchItems) {
      if (options?.signal?.aborted) break;
      let detail = null;
      try {
        detail = await getDetail(item.PRDT_NO, { signal: options?.signal, channel });
      } catch (err) {
        if (err?.message === 'aborted') break;
        console.warn(`[BulkFlow ABC마트] 상세 ${item.PRDT_NO} 실패:`, err.message);
        // 상세 실패해도 검색 데이터로만 product 구성 (degraded mode)
      }
      batchProducts.push(parseItem(item, detail, { channel }));
    }

    // 배치 단위 서버 전송 (서비스 워커 crash 안전)
    if (options?.onBatch) {
      try {
        await options.onBatch(batchProducts);
        totalSent += batchProducts.length;
      } catch (e) {
        console.error(`[BulkFlow ABC마트] 배치 ${batchNum} 전송 실패:`, e.message);
      }
    }

    allProducts.push(...batchProducts);

    const progress = 20 + Math.round(((batchStart + batchItems.length) / searchItems.length) * 80);
    onProgress(progress, searchItems.length, totalSent || allProducts.length, `처리: ${allProducts.length}/${searchItems.length}`);
  }

  const withOptions = allProducts.filter((p) => p.options && p.options.length > 1).length;
  onProgress(100, allProducts.length, allProducts.length, '수집 완료');
  console.log(`[BulkFlow ABC마트] 완료: ${allProducts.length}개 (옵션: ${withOptions})`);
  return allProducts;
}

/**
 * 임시 탭 정리 — ABC마트는 비로그인 fetch 만 사용 → noop.
 */
export function cleanupAbcmartTab() {
  // 비로그인 + tab-less fetch — 정리할 리소스 없음.
}
