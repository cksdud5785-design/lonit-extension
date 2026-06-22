// 목적: 패션플러스 (fashionplus.co.kr) collector — Phase 1 PoC
//
// 정찰 결과 (2026-04-29 PoC fixture: __tests__/__fixtures__/fashionplus/):
//   - robots.txt: User-agent: * Disallow: /mypage/ /guest-mypage/ /global/ /common/
//                 /detail/ /goods/detail/*/qna-iframe
//     · 'Disallow: /detail/' 는 RFC 9309 prefix-match 로 '/detail/...' 만 차단.
//       PDP 의 실제 path 는 '/goods/detail/{id}' 이므로 prefix '/detail/' 와 일치 X
//       → 본 collector 는 robots-conformant. 다만 mission spec 에서 ambiguity 명시 →
//       PR 본문에 robots 해석 근거 + Phase 1 PR 을 DRAFT 로 user 검토 권장 표기.
//   - 비로그인 fetch — 인증 / 쿠키 불필요
//   - 핵심 데이터 endpoint 3개:
//       1) GET /search/goods/fetch?searchWord=K&page=N  (XHR JSON, 09 doc 미문서화 발견)
//          → { goodsPaginator: { items: [{ id, no, name, brand: { name }, consumerPrice,
//              salePrice, displayPrice, thumbnailUrl, isSoldout, hasGoodsCoupon,
//              goodsCoupon: { amount, label }, isFreeDelivery, ... }, ...],
//              lastPage, totalCount?, ... } }
//          · 1page 당 10 items (contentPerPage)
//       2) GET /goods/detail/{id}                      (HTML, JSON-LD inline 추출)
//          → <script type="application/ld+json">{ name, image, description, sku, mpn,
//              brand: { name }, offers: { price, sale_price, priceCurrency, availability }}}
//          · 추가 이미지: data-preload="{ '_src': '...plgX{sellerId}_{sku}.jpg' }" (4-5장)
//       3) GET /goods/detail/{id}/fetch-option-data    (XHR JSON, ajax)
//          → 단일: [{ _name, _price, _image?, options: [{ _name, _price, _stock, _id }, ...] }]
//          → 묶음(bundle): [{ _name, _price, _image, options: { sub: [{ _name, _price, _stock, ... }] }}, ...]
//          · isBundle 플래그는 search items[].isBundle 에 표시 — 본 collector 는 bundle 시
//            첫 sub-product 1개만 정규화 (단일상품 시나리오 유지). bundle 전체 정규화는
//            Phase 2.
//   - PDP URL: /goods/detail/{9-digit id}
//
// rate-limiter (확장 client-side):
//   - 분당 30req 이내 (= 2000ms/req) — 09 doc 권장 200-400ms 보다 보수적
//   - 차단 시 increment delay + 5초 cooldown (abcmart 패턴)
//
// 출력 product shape: lotteon.js 의 parseItem 과 동일 — sourceMarket: 'fashionplus'.
// SourceFetcher 인터페이스 호환: parseUrl/searchProducts/getDetail/getOptions/getLeadDays/
//   collect/cleanupFashionplusTab.

// ─── 상수 ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.fashionplus.co.kr';
const SEARCH_URL = `${BASE_URL}/search/goods/fetch`;
const DETAIL_HTML_URL_PREFIX = `${BASE_URL}/goods/detail/`;
const PDP_URL_PREFIX = `${BASE_URL}/goods/detail/`;
const MAX_PAGES = 200; // 10 × 200 = 2000 건 상한 — 검색당
// 분당 30req = 2000ms/req. 09 doc 의 200-400ms 권장보다 보수적 (자체개발 플랫폼 → 보수).
const FETCH_DELAY_MS = 2000;
const STREAM_BATCH = 50;

// User-Agent — extension service worker 에서 fetch 시 자동 부여되지만, 일관 lookup 용.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─── rate-limiter (간단 큐) ──────────────────────────────────────────────────

let _lastFetchAt = 0;
let _consecutiveBlocks = 0;

/** 마지막 fetch 후 FETCH_DELAY_MS 경과 보장. 차단 누적 시 백오프. */
async function throttle() {
  const now = Date.now();
  const baseDelay = FETCH_DELAY_MS * Math.pow(2, Math.min(_consecutiveBlocks, 3));
  const elapsed = now - _lastFetchAt;
  if (elapsed < baseDelay) {
    await new Promise((r) => setTimeout(r, baseDelay - elapsed));
  }
  _lastFetchAt = Date.now();
}

/**
 * rate-limited fetch + JSON 파싱 + 재시도. 4xx/5xx 차단 시 backoff.
 *
 * @param {string} url
 * @param {{ retries?: number, signal?: AbortSignal, asText?: boolean }} opts
 * @returns {Promise<any>} JSON 객체 또는 (asText) HTML 문자열
 */
async function fetchSmart(url, opts = {}) {
  const retries = opts?.retries ?? 2;
  const signal = opts?.signal;
  const asText = !!opts?.asText;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new Error('aborted');
    await throttle();
    if (signal?.aborted) throw new Error('aborted');
    try {
      const headers = {
        'Accept': asText
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          : 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'User-Agent': USER_AGENT,
      };
      if (!asText) headers['X-Requested-With'] = 'XMLHttpRequest';

      const res = await fetch(url, { headers, signal });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 403) && i < retries) {
          _consecutiveBlocks++;
          console.warn(`[패션플러스] ${res.status} 차단 → ${5 * (i + 1)}초 대기 후 재시도`);
          await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      // 성공 시 차단 카운터 리셋
      _consecutiveBlocks = 0;
      if (asText) return await res.text();
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        // HTML 응답 (에러/리다이렉트) 도 200 가능 — 실패 처리
        throw new Error(`HTML 응답 수신 (content-type: ${contentType})`);
      }
      return await res.json();
    } catch (err) {
      if (i >= retries) throw err;
      console.warn(`[패션플러스] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ─── URL 파싱 ───────────────────────────────────────────────────────────────

/**
 * 검색 URL → 키워드/페이지 추출.
 * 지원 패턴:
 *   - https://www.fashionplus.co.kr/search/goods/result?searchWord=K
 *   - https://www.fashionplus.co.kr/search/goods/result?searchWord=K&page=2
 *   - 그 외 searchWord 또는 q 쿼리 파라미터
 *
 * @param {string} url
 * @returns {{ keyword: string, page: number }}
 */
export function parseUrl(url) {
  const params = { keyword: '', page: 1 };
  if (!url || typeof url !== 'string') return params;
  try {
    const u = new URL(url);
    params.keyword = u.searchParams.get('searchWord') || u.searchParams.get('q') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    if (Number.isFinite(page) && page > 0) params.page = page;
  } catch {
    // URL 파싱 실패 → keyword 로 사용
    params.keyword = url;
  }
  return params;
}

// ─── 검색 ───────────────────────────────────────────────────────────────────

/**
 * 검색 결과 1페이지 fetch.
 * @param {{ keyword: string, page?: number, signal?: AbortSignal }} params
 * @returns {Promise<{ items: Array<any>, lastPage: number }>}
 */
export async function searchProducts(params) {
  const keyword = params?.keyword || '';
  if (!keyword) return { items: [], lastPage: 0 };
  const page = params?.page ?? 1;

  const qs = new URLSearchParams({ searchWord: keyword, page: String(page) });
  const url = `${SEARCH_URL}?${qs}`;

  const data = await fetchSmart(url, { signal: params?.signal });
  const paginator = data?.goodsPaginator || {};
  const items = Array.isArray(paginator.items) ? paginator.items : [];
  const lastPage = Number(paginator.lastPage ?? 0) || 0;
  return { items, lastPage };
}

// ─── 상세 ───────────────────────────────────────────────────────────────────

/**
 * 상품 상세 HTML fetch + JSON-LD + 추가 이미지 추출.
 * @param {string|number} productId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ jsonLd: any|null, additionalImages: string[], rawHtml: string }>}
 */
export async function getDetail(productId, opts = {}) {
  if (!productId) throw new Error('productId 필수');
  const url = `${DETAIL_HTML_URL_PREFIX}${encodeURIComponent(String(productId))}`;
  const html = await fetchSmart(url, { signal: opts?.signal, asText: true });
  return parseDetailHtml(html);
}

/**
 * detail HTML → JSON-LD + 추가 이미지 + 배송 정보 정규화.
 *
 * 2026-04-29 Codex Round 1 (MEDIUM #2): 배송료/배송출발일은 unknown 이 아니라
 * 상세 HTML 의 <table> 안에 노출되어 있다 — extractShippingInfo 로 직접 파싱.
 *
 * @param {string} html
 * @returns {{ jsonLd: any|null, additionalImages: string[], shipping: { fee: number|null, isFree: boolean, leadDays: number|null }, rawHtml: string }}
 */
export function parseDetailHtml(html) {
  if (!html || typeof html !== 'string') {
    return {
      jsonLd: null,
      additionalImages: [],
      shipping: { fee: null, isFree: false, leadDays: null },
      rawHtml: '',
    };
  }
  // JSON-LD 추출 — application/ld+json 첫 블록 (Product schema)
  const jsonLd = extractJsonLd(html);
  // 추가 이미지: data-preload="{ '_src': 'https://img.fashionplus.co.kr/.../plg.../...' }"
  // (4-5장의 색상별/뷰별 메인 이미지)
  const additionalImages = extractAdditionalImages(html);
  // 배송정책 파싱 — '배송료' / '배송출발일' <table>
  const shipping = extractShippingInfo(html);
  return { jsonLd, additionalImages, shipping, rawHtml: html };
}

/**
 * HTML 문자열에서 첫 application/ld+json (Product schema) 객체 파싱.
 * @param {string} html
 * @returns {any|null}
 */
function extractJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;
  const match = html.match(re);
  if (!match) return null;
  try {
    // 패션플러스 JSON-LD 는 HTML-encoded ampersand (&amp;) 가 raw 로 들어가기도 함 → unescape.
    const raw = match[1].trim().replace(/&amp;/g, '&');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[패션플러스] JSON-LD 파싱 실패:', err.message);
    return null;
  }
}

/**
 * 배송정책 추출 — '배송료' table cell + '배송출발일' table cell.
 *
 * 패션플러스 detail HTML 구조 (2026-04-29 fixture 기반):
 *   <th>배송료</th>
 *     <td><p>일반지역: 무료배송<br>도서지역: 6,000원...</p></td>
 *   <th>배송출발일</th>
 *     <td>평균 배송 출발일 수: 결제확인 후 1~2일 ...</td>
 *
 * 정책: 일반지역 (default) 기준으로 fee/isFree 결정. 도서지역 추가비는 별도 노출.
 * leadDays: '1~2일' 의 max (보수적). 매칭 실패 시 null.
 *
 * @param {string} html
 * @returns {{ fee: number|null, isFree: boolean, leadDays: number|null }}
 */
function extractShippingInfo(html) {
  const result = { fee: null, isFree: false, leadDays: null };
  if (!html) return result;

  // '배송료' th 다음의 td 내용 추출 — span/br/<p> 등 분리 텍스트 모두 포함
  const feeMatch = html.match(/<th[^>]*>\s*<b[^>]*>\s*배송료\s*<\/b>\s*<\/th>([\s\S]*?)<\/tr>/);
  if (feeMatch) {
    const block = feeMatch[1];
    // '일반지역: 무료배송' 또는 '일반지역: 3,000원' 등
    if (/일반지역[^<]*무료배송/.test(block)) {
      result.isFree = true;
      result.fee = 0;
    } else {
      // '일반지역: 3,000원' 형태에서 첫 숫자 추출
      const won = block.match(/일반지역[^<]*?([0-9,]+)\s*원/);
      if (won) {
        const num = Number(won[1].replace(/,/g, ''));
        if (Number.isFinite(num) && num > 0) {
          result.fee = num;
          result.isFree = false;
        }
      }
    }
  }

  // '배송출발일' td 텍스트에서 '1~2일' / '1-3일' / '2일' 등 추출, max 채택
  const leadMatch = html.match(/<th[^>]*>\s*<b[^>]*>\s*배송출발일\s*<\/b>\s*<\/th>([\s\S]*?)<\/tr>/);
  if (leadMatch) {
    const block = leadMatch[1];
    const range = block.match(/(\d+)\s*[~\-~]\s*(\d+)\s*일/);
    if (range) {
      const max = Math.max(Number(range[1]), Number(range[2]));
      if (Number.isFinite(max) && max > 0) result.leadDays = max;
    } else {
      const single = block.match(/(\d+)\s*일/);
      if (single) {
        const n = Number(single[1]);
        if (Number.isFinite(n) && n > 0) result.leadDays = n;
      }
    }
  }

  return result;
}

/**
 * data-preload _src 의 실 이미지 URL 추출 (메인 4-5장 색상별/뷰별).
 * 같은 이미지 dedup, plg/plgk/plgl/plgr 접두 (default/back/labels/detail) 모두 보존.
 * @param {string} html
 * @returns {string[]}
 */
function extractAdditionalImages(html) {
  const re = /data-preload="\{\s*'_src':\s*'([^']+)'/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    // plg{sellerId}_... 이미지만 메인 이미지로 채택 (배너/광고 제외)
    if (!url.includes('/product_img/')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * 옵션 ajax fetch — /goods/detail/{id}/fetch-option-data
 * 단일: [{ options: [{ _name, _price, _stock, _id }, ...] }]
 * 묶음: [{ options: { sub: [...] } }, ...]  (각 entry 가 sub-product)
 *
 * @param {string|number} productId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} raw JSON (Array)
 */
export async function fetchOptionData(productId, opts = {}) {
  if (!productId) throw new Error('productId 필수');
  const url = `${DETAIL_HTML_URL_PREFIX}${encodeURIComponent(String(productId))}/fetch-option-data`;
  return await fetchSmart(url, { signal: opts?.signal });
}

/**
 * fetch-option-data 응답 → 표준 옵션 배열로 정규화.
 *
 * 2026-04-29 Codex Round 1 (MEDIUM #1): collect() 는 isBundle 항목을 skip 하므로
 * 정상 흐름에서는 단일 product (options 가 배열) shape 만 들어온다. defensive 로
 * options.sub 도 처리는 유지하지만, 본 함수가 bundle parent 입력을 받았다는 건
 * 호출 경로 버그 신호이므로 console.warn 로 표면화.
 *
 * @param {any} optionData raw fetchOptionData 결과
 * @returns {Array<{ optionName: string, optionType: string, sku: string, stock: number, isSoldout: boolean, priceDiff: number }>}
 */
export function getOptions(optionData) {
  if (!Array.isArray(optionData) || optionData.length === 0) {
    return [
      { optionName: 'FREE', optionType: 'none', sku: '', stock: 0, isSoldout: true, priceDiff: 0 },
    ];
  }

  // 단일상품 (첫 entry 의 options 가 배열) 또는 묶음 (options.sub) 자동 감지.
  // 정상 collect() 흐름에서는 isBundle skip → 항상 단일 shape. bundle 입력은 defensive.
  const first = optionData[0] || {};
  let rawOptions;
  if (Array.isArray(first.options)) {
    rawOptions = first.options;
  } else if (first.options && Array.isArray(first.options.sub)) {
    // bundle — 첫 sub-product 의 sub 배열 사용 (defensive only — collect 가 skip)
    console.warn('[패션플러스] getOptions 가 bundle parent shape 를 받음 — collect 경로 검토 필요');
    rawOptions = first.options.sub;
  } else {
    rawOptions = [];
  }

  if (rawOptions.length === 0) {
    return [
      { optionName: 'FREE', optionType: 'none', sku: '', stock: 0, isSoldout: true, priceDiff: 0 },
    ];
  }

  const basePrice = Number(first._price ?? 0) || 0;

  return rawOptions.map((opt) => {
    const stock = Number(opt?._stock ?? 0) || 0;
    const optName = String(opt?._name ?? '').trim();
    // 사이즈/색상 type 자동 감지 — '_' 또는 ' ' 구분자가 있고 둘째 토큰이 사이즈 패턴이면 size
    const isSizeOpt = /(^|[\s_])(XS|S|M|L|XL|XXL|FREE|F|\d{2,3}|\d+T|\d+호)\b/i.test(optName);
    const optionPrice = Number(opt?._price ?? basePrice) || 0;
    const priceDiff = optionPrice - basePrice;
    return {
      optionName: optName || 'FREE',
      optionType: isSizeOpt ? 'size' : 'mixed',
      sku: String(opt?._id ?? ''),
      stock,
      isSoldout: stock <= 0,
      priceDiff,
    };
  });
}

/**
 * 출고 소요일 추정.
 *
 * 2026-04-29 Codex Round 1 (MEDIUM #2): detail HTML 의 '배송출발일' 셀이 노출하는
 * 실값을 우선 사용. extractShippingInfo 가 채워준 leadDays > 0 이면 그 값을, 아니면
 * 09 doc 의 평균 보수값 2 사용 (셀러 직배송 가능성 감안).
 *
 * @param {{ shipping?: { leadDays: number|null } }|null} detail   parseDetailHtml 결과
 * @returns {number}
 */
export function getLeadDays(detail = null) {
  const fromHtml = detail?.shipping?.leadDays;
  if (Number.isFinite(fromHtml) && fromHtml > 0) return fromHtml;
  // 09 doc Section 9.B.4 — '평균 1-3일 출고' 셀러 직배송은 길어질 수 있음
  return 2;
}

// ─── 결과 정규화 ─────────────────────────────────────────────────────────────

/**
 * 검색 항목 + 상세 HTML + 옵션 → 표준 product 객체.
 * 출력 shape 는 lotteon.js parseItem 과 동일 (sourceMarket 만 'fashionplus').
 *
 * @param {any} searchItem  goodsPaginator.items[i]
 * @param {{ jsonLd: any|null, additionalImages: string[] }|null} detail   parseDetailHtml 결과
 * @param {Array<any>|null} optionData  fetchOptionData raw 결과
 * @returns {object} 표준 product
 */
export function parseItem(searchItem, detail = null, optionData = null) {
  const productId = String(searchItem?.id ?? detail?.jsonLd?.mpn ?? '');
  const sku = String(searchItem?.no ?? detail?.jsonLd?.sku ?? '');
  // 검색 fallback
  const searchName = String(searchItem?.name ?? '');
  const searchBrand = String(searchItem?.brand?.name ?? '');
  const searchThumb = String(searchItem?.thumbnailUrl ?? '');
  const searchConsumer = Number(searchItem?.consumerPrice ?? 0) || 0;
  const searchSale = Number(searchItem?.salePrice ?? searchConsumer) || 0;
  const searchDisplay = Number(searchItem?.displayPrice ?? searchSale) || 0;

  // JSON-LD 우선
  const jsonLd = detail?.jsonLd || null;
  const ldName = jsonLd ? String(jsonLd.name ?? '') : '';
  const ldBrand = jsonLd ? String(jsonLd.brand?.name ?? '') : '';
  const ldOffer = jsonLd?.offers || {};
  const ldPrice = Number(ldOffer.price ?? 0) || 0;
  const ldSale = Number(ldOffer.sale_price ?? ldPrice) || 0;
  const ldImages = Array.isArray(jsonLd?.image) ? jsonLd.image : [];
  const ldDescription = jsonLd ? String(jsonLd.description ?? '') : '';

  const name = ldName || searchName;
  const brand = ldBrand || searchBrand;
  const originalPrice = ldPrice || searchConsumer;
  const sellPrice = ldSale || searchSale;

  // displayPrice 가 sellPrice 보다 작으면 = goodsCoupon 자동할인 적용가
  const couponPrice = (searchDisplay > 0 && searchDisplay < sellPrice) ? searchDisplay : 0;

  // 이미지 — JSON-LD image[] + detail additionalImages dedup, search thumbnail fallback
  const imageList = [];
  const seenImages = new Set();
  for (const url of ldImages) {
    const clean = String(url).replace(/&amp;/g, '&');
    if (!seenImages.has(clean)) {
      seenImages.add(clean);
      imageList.push(clean);
    }
  }
  for (const url of (detail?.additionalImages || [])) {
    if (!seenImages.has(url)) {
      seenImages.add(url);
      imageList.push(url);
    }
  }
  if (imageList.length === 0 && searchThumb) {
    imageList.push(searchThumb);
  }
  const thumbnail = imageList[0] || '';

  // 옵션 / 재고
  const options = optionData ? getOptions(optionData) : [];
  const totalStock = options.reduce((sum, o) => sum + (o.stock || 0), 0);

  // 품절 판정: search isSoldout 또는 모든 옵션 품절 또는 JSON-LD availability 비활성
  const ldAvailability = String(ldOffer.availability ?? '').toLowerCase();
  const ldOos = ldAvailability && !ldAvailability.includes('instock');
  const searchOos = searchItem?.isSoldout === true;
  const allOptionsOos = options.length > 0 && options.every((o) => o.isSoldout);
  const isSoldout = ldOos || searchOos || allOptionsOos;

  // 카테고리 — 패션플러스 detail HTML 의 breadcrumb 추출 미구현 (Phase 2). 현재 빈 문자열.
  const categorySource = '';

  // 배송:
  //   1순위 — detail HTML 의 '배송료' 셀 (extractShippingInfo). 일반지역 기준 fee/isFree.
  //   2순위 — search isFreeDelivery 또는 name 에 '[무료배송]' 포함 시 free.
  // 2026-04-29 Codex Round 1 (MEDIUM #2): detail 에 shipping.fee/isFree 가 채워져
  // 있으면 그 값을 사용. unknown 일 때만 search/name fallback.
  const detailShipping = detail?.shipping || {};
  const nameHasFree = /\[?\s*무료배송\s*\]?/.test(name) || /\[?\s*무료배송\s*\]?/.test(ldDescription);
  let shippingType;
  let shippingFee;
  if (detailShipping.fee !== null && detailShipping.fee !== undefined) {
    // detail HTML 에서 실 값 추출 — most authoritative
    shippingType = detailShipping.isFree ? 'free' : 'paid';
    shippingFee = detailShipping.fee;
  } else if (searchItem?.isFreeDelivery === true || nameHasFree) {
    shippingType = 'free';
    shippingFee = 0;
  } else {
    // detail 미수집 + search 도 명시 없음 → unknown (fabricate 금지)
    shippingType = 'paid';
    shippingFee = null;
  }
  const isFreeDelivery = shippingType === 'free';
  void isFreeDelivery; // 디버그/회귀용 — 명시 변수 유지

  return {
    sourceMarket: 'fashionplus',
    sourceId: productId,
    sourceUrl: `${PDP_URL_PREFIX}${productId}`,
    brand,
    originalTitle: name,
    originalPrice,
    sellPrice,
    couponPrice,
    discount: Number(searchItem?.saleRate ?? 0) || 0,
    categorySource,
    thumbnail,
    images: imageList,
    specs: {
      ...(sku ? { sellerSku: sku } : {}),
      ...(searchItem?.sellerId ? { sellerId: String(searchItem.sellerId) } : {}),
      ...(searchItem?.brand?.id ? { brandId: String(searchItem.brand.id) } : {}),
    },
    options,
    totalStock,
    isSoldout,
    reviewScore: Number(jsonLd?.aggregateRating?.ratingValue ?? 0) || 0,
    reviewCount: Number(jsonLd?.aggregateRating?.reviewCount ?? searchItem?.sellCount ?? 0) || 0,
    storeName: '패션플러스',
    todayArrive: false, // 09 doc 별도 명시 없음
    benefitPrice: null, // 회원가/적립가/카드즉시 — Phase 2
    cardBenefitPrice: null,
    benefitDetails: null,
    // 2026-05-18: 정보고시 — fashionplus PDP 표준 필드.
    productNotices: {
      manufacturer: String(brand || '패션플러스'),
      importer: '주식회사 패션플러스',
      manufactureCountry: '상세설명 참조',
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: '패션플러스 고객센터 1644-0203',
    },
    shippingType,
    // 2026-04-29 Codex Round 1 (MEDIUM #2): detail HTML '배송료' 셀에서 추출한 실값.
    // unknown 시 null (fabricate 금지).
    shippingFee,
    sourceLeadDays: getLeadDays(detail),
  };
}

// ─── 메인 collect ────────────────────────────────────────────────────────────

/**
 * 패션플러스 검색 → 수집 메인 진입점.
 * @param {string} url           검색 URL
 * @param {number} limit         최대 수집 건수
 * @param {Function} onProgress  진행률 콜백 (percent, total, sent, message)
 * @param {object} options       { onBatch, signal }
 * @returns {Promise<Array<object>>} 수집된 product 배열
 */
export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  const { keyword } = parsed;

  if (!keyword) {
    console.error('[BulkFlow 패션플러스] 키워드 없음:', url);
    return [];
  }

  console.log('[BulkFlow 패션플러스] 수집 시작:', { keyword, limit });
  onProgress(0, 0, 0, '패션플러스 검색중...');

  // ── 1단계: 검색 결과 페이지네이션 ──
  const searchItems = [];
  const seenIds = new Set();
  let lastPage = 0;
  let totalSent = 0;

  for (let page = parsed.page || 1; page <= MAX_PAGES; page++) {
    if (searchItems.length >= limit) break;
    if (options?.signal?.aborted) break;

    let resp;
    try {
      resp = await searchProducts({ keyword, page, signal: options?.signal });
    } catch (err) {
      console.error(`[BulkFlow 패션플러스] 검색 페이지 ${page} 실패:`, err.message);
      break;
    }

    if (resp.lastPage && !lastPage) lastPage = resp.lastPage;
    if (!resp.items.length) break;

    let newOnPage = 0;
    let bundleSkipped = 0;
    for (const it of resp.items) {
      const id = String(it?.id ?? '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      // 2026-04-29 Codex Round 1 (MEDIUM #1): bundle (isBundle:true) 은 옵션 schema 가
      // 'options.sub[]' 로 sub-product 메타가 parent search/JSON-LD 와 다른 시드. parent
      // 메타 + 첫 sub 옵션을 섞으면 가격/이미지 일관성이 깨진다 (sub 의 _name/_price/_image
      // 가 parent 와 별개). Phase 1 안전 정책: bundle 전체 skip. Phase 2 에서 sub-product
      // 별 standalone product 로 정규화 (id 별도 부여 + 메타 child 기준).
      if (it.isBundle === true) {
        bundleSkipped++;
        continue;
      }
      searchItems.push(it);
      newOnPage++;
      if (searchItems.length >= limit) break;
    }
    if (bundleSkipped > 0) {
      console.log(`[BulkFlow 패션플러스] 페이지 ${page}: bundle ${bundleSkipped}개 skip (Phase 2 deferred)`);
    }

    const progress = Math.min(20, Math.round((searchItems.length / limit) * 20));
    onProgress(
      progress, lastPage * 10, searchItems.length,
      `검색: ${searchItems.length}/${Math.min(limit, lastPage * 10)}`,
    );

    if (newOnPage === 0) break;
    if (lastPage > 0 && page >= lastPage) break;
  }

  if (searchItems.length === 0) {
    onProgress(100, 0, 0, '검색 결과 없음');
    return [];
  }

  console.log(`[BulkFlow 패션플러스] 검색 완료: ${searchItems.length}개 → ${STREAM_BATCH}개씩 상세 처리`);

  // ── 2단계: STREAM_BATCH 단위 상세 + 옵션 + 정규화 + 서버 전송 ──
  const allProducts = [];

  for (let batchStart = 0; batchStart < searchItems.length; batchStart += STREAM_BATCH) {
    if (options?.signal?.aborted) break;
    const batchItems = searchItems.slice(batchStart, batchStart + STREAM_BATCH);
    const batchNum = Math.floor(batchStart / STREAM_BATCH) + 1;
    const totalBatches = Math.ceil(searchItems.length / STREAM_BATCH);

    console.log(`[BulkFlow 패션플러스] 배치 ${batchNum}/${totalBatches}: ${batchItems.length}개 처리중`);

    const batchProducts = [];
    for (const item of batchItems) {
      if (options?.signal?.aborted) break;
      let detail = null;
      let optionData = null;
      try {
        detail = await getDetail(item.id, { signal: options?.signal });
      } catch (err) {
        if (err?.message === 'aborted') break;
        console.warn(`[BulkFlow 패션플러스] 상세 ${item.id} 실패:`, err.message);
      }
      try {
        optionData = await fetchOptionData(item.id, { signal: options?.signal });
      } catch (err) {
        if (err?.message === 'aborted') break;
        console.warn(`[BulkFlow 패션플러스] 옵션 ${item.id} 실패:`, err.message);
      }
      // 2026-04-29 Codex Round 2 (HIGH): option fetch 실패 또는 빈 결과 + non-soldout 일 때
      // parseItem 으로 emit 하면 server 가 live item 을 options=[]/totalStock=0 으로
      // overwrite 할 위험 (재고 0 정합 사고). search-soldout (item.isSoldout=true) 만
      // 진짜 0-stock 이며, 그 외엔 skip 으로 update-preserve 한다.
      const optionFetchOk = optionData !== null && optionData !== undefined;
      const searchSoldout = item?.isSoldout === true;
      if (!optionFetchOk && !searchSoldout) {
        console.warn(
          `[BulkFlow 패션플러스] ${item.id} skip — 옵션 fetch 실패 + non-soldout (live item zero-stock overwrite 차단)`,
        );
        continue;
      }
      batchProducts.push(parseItem(item, detail, optionData));
    }

    if (options?.onBatch) {
      try {
        await options.onBatch(batchProducts);
        totalSent += batchProducts.length;
      } catch (e) {
        console.error(`[BulkFlow 패션플러스] 배치 ${batchNum} 전송 실패:`, e.message);
      }
    }

    allProducts.push(...batchProducts);

    const progress = 20 + Math.round(((batchStart + batchItems.length) / searchItems.length) * 80);
    onProgress(progress, searchItems.length, totalSent || allProducts.length, `처리: ${allProducts.length}/${searchItems.length}`);
  }

  const withOptions = allProducts.filter((p) => p.options && p.options.length > 1).length;
  onProgress(100, allProducts.length, allProducts.length, '수집 완료');
  console.log(`[BulkFlow 패션플러스] 완료: ${allProducts.length}개 (옵션: ${withOptions})`);
  return allProducts;
}

/**
 * 임시 탭 정리 — 패션플러스는 비로그인 fetch 만 사용 → noop.
 */
export function cleanupFashionplusTab() {
  // 비로그인 + tab-less fetch — 정리할 리소스 없음.
}
