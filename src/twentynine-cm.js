// 목적: 29CM (29cm.co.kr) collector — Phase 1 PoC (parser primitives only).
//
// 정찰 (docs/overnight-20260428/09-new-sources-recon.md) + Codex Round 1 live verify:
//   - robots.txt: User-agent: * Allow / (Baiduspider 만 차단). Crawl-delay 없음.
//   - PDP URL: https://www.29cm.co.kr/products/{productId}  (7자리 숫자) ✓ confirmed
//   - 검색 URL: https://www.29cm.co.kr/store/search?keyword=...        ✓ confirmed
//   - 브랜드 URL: https://www.29cm.co.kr/store/brand/{brandId}         ✓ confirmed (numeric)
//
// IMPORTANT — Codex Round 1 (2026-04-29) live verify findings:
//   - **PDP 는 App Router (Next.js 13+)**. `__NEXT_DATA__` 가 아니라 `self.__next_f` Flight
//     스트림. 정찰 doc 의 "Next.js 15 SSR + __NEXT_DATA__" 가정은 PDP 에서 거짓.
//   - **검색/브랜드 페이지는 SSR `__NEXT_DATA__` 존재** 하지만 `pageProps` 에 상품 리스트
//     없음 (`$cookie, $ua, _sentryBaggage, _sentryTraceData` 만). PDP 링크 `/products/{id}`
//     는 SSR HTML 에 0 건 — 클라이언트 hydration 후 동적 fetch.
//   - **결론**: PDP detail / search list 모두 별도 BFF API endpoint 필요. live fixture
//     없이 추정 구현하면 silent empty-success → 운영 회귀 (Codex CRITICAL+HIGH).
//
// Phase 1 PoC 범위 (이 PR — scope-down 후):
//   - **parser primitives 만** (pure functions, fixture-ready):
//     parseUrl / extractProductIdsFromSearchHtml / extractNextData /
//     parseDetailFromNextData / parseLeadDays — Phase 2 에서 fixture 확보 후 그대로 활용.
//   - **collect() 는 explicit throw** ("PoC pending live fixture validation") — Codex
//     CRITICAL/HIGH 회피. background.js → registry → collect 호출 시 명시적 에러로
//     skeleton 동작 유지 (PR #847 패턴과 정확히 동일).
//
// Phase 2 (별 PR — Codex 권장 순서):
//   1) live PDP HAR 캡처 + BFF endpoint 발견 (e.g. `api.29cm.co.kr/...`)
//   2) live search/brand product-list endpoint 발견 (Flight payload 또는 별도 BFF)
//   3) parseDetailFromNextData → parseDetail (live shape 으로 fallback key 재검증)
//   4) collect() 활성화 — 1상품 e2e 검증 후
//   5) 회원 혜택가 / chrome.cookies tab 패턴 (musinsa.js mirror)
//   6) 서버측 source-fetcher + rate-limiter vendor entry
//
// musinsa-mirror 정책:
//   - 같은 origin (29cm.co.kr) sister site (무신사 2021 인수) 라 retry/header 패턴은
//     준비된 상태로 보존 — Phase 2 BFF endpoint 발견 시 그대로 wire.
//   - DELAY_MIN/MAX, getCookieAwareHeaders, twentynineCmFetch 모두 musinsa.js mirror.

console.log('[Lonit] twentynine-cm.js v0.3.0 — BFF listing/options collector enabled');

const DELAY_MIN = 100;
const DELAY_MAX = 260;
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const SOURCE_MARKET = '29cm';
const HOST = 'https://www.29cm.co.kr';
const SEARCH_API_URL = 'https://display-bff-api.29cm.co.kr/api/v1/listing/items?colorchipVariant=treatment';
const DETAIL_API_BASE = 'https://bff-api.29cm.co.kr/api/v6/product-detail';
const OPTIONS_API_BASE = DETAIL_API_BASE;
const PAGE_SIZE = 50;
const STREAM_BATCH = 20;
const MAX_STOCK = 99;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
}

function getHeaders() {
  return {
    'Accept': 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': `${HOST}/`,
    'Origin': HOST,
  };
}

// chrome.cookies 기반 세션 주입 — 무신사 패턴 mirror (회원 쿠폰 등 Phase 2 에서 사용).
async function getCookieAwareHeaders() {
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const cookieList = await chrome.cookies.getAll({ domain: '.29cm.co.kr' });
      if (cookieList.length > 0) {
        const cookieStr = cookieList.map((c) => `${c.name}=${c.value}`).join('; ');
        return { ...getHeaders(), 'Cookie': cookieStr };
      }
    }
  } catch {
    /* chrome API unavailable in test/Node env */
  }
  return getHeaders();
}

async function twentynineCmFetch(url, init = {}, context = '29cm') {
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(await getCookieAwareHeaders()),
        ...(init.headers || {}),
      },
    });

    if (resp.ok) return resp;

    if (!RETRYABLE_STATUSES.has(resp.status) || attempt >= maxRetries) {
      throw new Error(`29CM ${resp.status}: ${context}`);
    }

    const waitMs = resp.status === 429
      ? Math.min(15000, 2000 * Math.pow(2, attempt))
      : 800 + (attempt * 700);
    console.warn(`[BulkFlow] 29CM 재시도 ${context}: ${resp.status}, ${waitMs}ms 대기 (${attempt + 1}/${maxRetries})`);
    await delay(waitMs);
  }

  throw new Error(`29CM fetch 실패: ${context}`);
}

/**
 * URL 파싱 — PDP id / 검색 키워드 추출.
 *
 * 인식 패턴:
 *   - /products/{id} → { productId }
 *   - /store/search?keyword=... → { keyword }
 *   - /search?keyword=... → { keyword }
 *   - /(shop/)?brand/{slug} → { brand }
 *
 * @param {string} url
 * @returns {{ productId?: string, keyword?: string, brand?: string }}
 */
export function parseUrl(url) {
  const params = {};
  if (!url || typeof url !== 'string') return params;
  try {
    const u = new URL(url);
    const productMatch = u.pathname.match(/\/(?:products|catalog)\/(\d{4,10})\b/);
    if (productMatch) {
      params.productId = productMatch[1];
    }
    if (u.searchParams.has('keyword')) {
      params.keyword = u.searchParams.get('keyword');
    }
    const brands = (u.searchParams.get('brands') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (brands.length > 0) {
      params.brands = brands;
    }
    const brandMatch = u.pathname.match(/\/(?:shop\/)?brand\/([^/?#]+)/);
    if (brandMatch) {
      params.brand = decodeURIComponent(brandMatch[1]);
    }
  } catch {
    if (url.length > 0 && url.length < 200) {
      params.keyword = url;
    }
  }
  return params;
}

/**
 * 검색 결과 HTML 에서 PDP /products/{id} 링크의 productId 추출.
 *
 * Next.js 15 hydration 페이지라 SSR HTML 에 PDP 링크가 들어있다 (a href 또는 __NEXT_DATA__).
 * Set 으로 dedup, 등장 순서 보존.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function extractProductIdsFromSearchHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const ids = [];
  const re = /\/products\/(\d{4,10})\b/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * HTML 에서 __NEXT_DATA__ JSON 추출.
 *
 * Next.js 15 SSR 표준 마커 — `<script id="__NEXT_DATA__" type="application/json">{...}</script>`.
 * 무신사 패턴과 다른 점: 무신사는 `"__NEXT_DATA__" type=...` 로 substring 검색.
 * 29CM 는 표준 형식 추정 → 두 패턴 모두 시도 (resilience).
 *
 * @param {string} html
 * @returns {object|null}
 */
export function extractNextData(html) {
  if (!html || typeof html !== 'string') return null;
  const stdRe = /<script\s+id="__NEXT_DATA__"\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/;
  const stdMatch = html.match(stdRe);
  if (stdMatch) {
    try {
      return JSON.parse(stdMatch[1]);
    } catch {
      /* fall through */
    }
  }
  const marker = '"__NEXT_DATA__" type="application/json">';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const end = html.indexOf('</script>', idx + marker.length);
  if (end === -1) return null;
  try {
    return JSON.parse(html.substring(idx + marker.length, end));
  } catch {
    return null;
  }
}

function pickFirst(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return null;
}

function normalizeImageUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

/**
 * __NEXT_DATA__ 의 product 데이터 정규화.
 *
 * 29CM 의 정확한 키 경로는 사이트 변경 가능성 → 후보 경로 다단계 fallback.
 * 모든 후보는 안전 navigation (없으면 null/0/[] default).
 *
 * 추정 후보 (recon doc B.1/B.2 + Next.js 일반 패턴):
 *   - props.pageProps.product
 *   - props.pageProps.itemDetail
 *   - props.pageProps.initialState.product
 *
 * @param {object} nextData
 * @returns {{
 *   productId: string|null,
 *   name: string,
 *   brand: string,
 *   brandSlug: string,
 *   originalPrice: number,
 *   sellPrice: number,
 *   images: string[],
 *   options: Array<{ name: string, optionName: string, sku: string, stock: number, isSoldout: boolean, priceDiff: number }>,
 *   category: string|null,
 *   description: string|null,
 * }|null}
 */
export function parseDetailFromNextData(nextData) {
  if (!nextData || typeof nextData !== 'object') return null;
  const pageProps = nextData?.props?.pageProps || {};
  const product = pageProps.product
    || pageProps.itemDetail
    || pageProps.initialState?.product
    || pageProps.dehydratedState?.queries?.[0]?.state?.data
    || null;
  if (!product || typeof product !== 'object') return null;

  const productId = pickFirst(product.itemNo, product.id, product.productId, product.no);
  const name = pickFirst(product.itemName, product.name, product.title, product.frontName) || '';
  const brand = pickFirst(
    product.brandName,
    product.brand?.brandName,
    product.brand?.name,
    typeof product.brand === 'string' ? product.brand : null,
  ) || '';
  const brandSlug = pickFirst(
    product.brandSlug,
    product.brand?.brandSlug,
    product.brand?.slug,
  ) || '';

  const priceInfo = product.priceInfo || product.price || {};
  const originalPriceRaw = pickFirst(
    priceInfo.consumerPrice,
    priceInfo.normalPrice,
    priceInfo.originalPrice,
    product.consumerPrice,
    product.normalPrice,
  ) ?? 0;
  const sellPriceRaw = pickFirst(
    priceInfo.salePrice,
    priceInfo.sellPrice,
    priceInfo.lastSalePrice,
    priceInfo.couponPrice,
    product.salePrice,
    product.sellPrice,
  ) ?? originalPriceRaw;

  const images = [];
  const candidateImages = pickFirst(
    product.images,
    product.imageUrls,
    product.itemImages,
    product.galleryImages,
  ) || [];
  for (const img of candidateImages) {
    if (!img) continue;
    const url = typeof img === 'string'
      ? img
      : pickFirst(img.url, img.imageUrl, img.src);
    const normalized = normalizeImageUrl(url);
    if (normalized && !images.includes(normalized)) images.push(normalized);
  }
  const thumb = normalizeImageUrl(product.thumbnailUrl);
  if (thumb) {
    // 이미 이미지 리스트에 있으면 제거 후 맨 앞에 추가 (대표 이미지 우선)
    const existingIdx = images.indexOf(thumb);
    if (existingIdx >= 0) images.splice(existingIdx, 1);
    images.unshift(thumb);
  }

  const rawOptions = pickFirst(
    product.options,
    product.sizeOptions,
    product.itemOptions,
    product.variants,
  ) || [];
  const options = rawOptions.map((opt) => {
    const optName = pickFirst(opt.optionName, opt.name, opt.title, opt.size) || '';
    const optType = pickFirst(opt.optionType, opt.optionGroupName) || 'size';
    const stockRaw = pickFirst(opt.stock, opt.quantity, opt.remainQuantity);
    const stock = typeof stockRaw === 'number' && Number.isFinite(stockRaw) ? Math.max(0, stockRaw) : 0;
    const isSoldout = opt.isSoldout === true
      || opt.soldOut === true
      || opt.outOfStock === true
      || stock === 0;
    return {
      name: optName,
      optionName: optType,
      sku: pickFirst(opt.sku, opt.optionCode, opt.code) || '',
      stock,
      isSoldout,
      priceDiff: Number(pickFirst(opt.priceDiff, opt.additionalPrice)) || 0,
    };
  });

  const category = pickFirst(
    product.categoryName,
    product.category?.name,
    Array.isArray(product.categoryPath)
      ? product.categoryPath.map((c) => c?.name || c).filter(Boolean).join(' > ') || null
      : null,
  );

  const description = pickFirst(
    product.deliveryInfo?.description,
    product.shipping?.description,
    product.shippingInfo?.description,
  );

  return {
    productId: productId ? String(productId) : null,
    name,
    brand,
    brandSlug,
    originalPrice: Number(originalPriceRaw) || 0,
    sellPrice: Number(sellPriceRaw) || 0,
    images,
    options,
    category,
    description,
  };
}

/**
 * 출고소요일 텍스트 휴리스틱 — recon doc B.4.
 *
 *   - "당일" / "익일" / "내일" / "다음날" 발송/배송/도착 → 1
 *   - "1~3일" / "1-3일" 범위 → max (보수적)
 *   - "주말제외 N일" → N (영업일)
 *   - "최대 N일" / "N일" / "N일 이내" → N
 *
 * 실패 시 default 2 (29CM 평균).
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function parseLeadDays(text) {
  if (!text || typeof text !== 'string') return 2;
  if (/당일\s*(발송|출고|배송)/.test(text)) return 1;
  if (/(익일|내일|다음날)\s*(배송|도착|출고)/.test(text)) return 1;
  let m = text.match(/(\d{1,2})\s*[~\-–]\s*(\d{1,2})\s*일/);
  if (m) {
    const upper = parseInt(m[2], 10);
    if (Number.isFinite(upper) && upper >= 1 && upper <= 30) return upper;
  }
  m = text.match(/주말\s*제외\s*(\d{1,2})\s*일/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  }
  m = text.match(/(?:최대\s*)?(\d{1,2})\s*일\s*(?:이내|소요|걸림)?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  }
  return 2;
}

// Phase 2 sentinel — collect/searchProducts/getDetail 활성화 가드.
//   - Codex Round 1 (2026-04-29): live PDP 가 App Router 라 __NEXT_DATA__ 부재,
//     live search SSR HTML 에 PDP 링크 0 건. fixture 확보 전 활성화 시 silent
//     empty-success → 운영 회귀.
//   - throw 메시지는 PR #847 의 다른 8 skeleton 들 (TODO_NOT_IMPLEMENTED) 패턴과 일관.
const PHASE2_PENDING = '29CM Phase 1 PoC — live fixture 확보 후 Phase 2 PR 에서 활성화. '
  + 'PDP 는 App Router (self.__next_f), search SSR 에 PDP 링크 부재 — BFF endpoint 발견 필요.';

/**
 * 검색 (Phase 2 — live BFF endpoint 발견 후 활성화).
 *
 * Codex Round 1 (2026-04-29) live verify: `/store/search?keyword=...` SSR HTML
 * 에 `__NEXT_DATA__` 는 있지만 `pageProps` 가 metadata-only (cookie/UA/sentry).
 * `/products/{id}` 링크 0 건 — 클라이언트 hydration 후 동적 fetch.
 * `extractProductIdsFromSearchHtml` 는 fixture 확보 후 다른 source 패턴 (e.g.
 * Flight payload 안 PDP 링크) 매치하도록 보강 가능.
 *
 * @param {{ keyword?: string, brand?: string }} _params
 * @returns {Promise<never>}
 */
function capStock(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_STOCK;
  return Math.min(Math.max(0, n), MAX_STOCK);
}

function asNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#xFEFF;|\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalize29cmImage(raw) {
  const normalized = normalizeImageUrl(raw);
  if (!normalized) return null;
  return normalized.startsWith('http') ? normalized : `https://img.29cm.co.kr${normalized}`;
}

function getCategorySource(item) {
  const event = item?.itemEvent?.eventProperties || {};
  return [
    event.largeCategoryName,
    event.middleCategoryName,
    event.smallCategoryName,
  ].filter(Boolean).join(' > ');
}

function optionSoldOut(opt) {
  const limitedQty = Number(opt?.limitedQty);
  return opt?.frontOptionStockStatus === 'SOLD_OUT'
    || opt?.optionStockStatus === 0
    || opt?.isSoldOut === true
    || (Number.isFinite(limitedQty) && limitedQty <= 0);
}

function flattenOptions(list, layout = [], prefix = []) {
  const out = [];
  for (const opt of Array.isArray(list) ? list : []) {
    const title = String(opt?.title ?? opt?.optionName ?? opt?.name ?? '').trim();
    const nextPrefix = title ? [...prefix, title] : prefix;
    if (Array.isArray(opt?.list) && opt.list.length > 0) {
      out.push(...flattenOptions(opt.list, layout, nextPrefix));
      continue;
    }
    const optionName = nextPrefix.join(' / ') || title || 'FREE';
    const sold = optionSoldOut(opt);
    out.push({
      optionName,
      optionType: layout.length > 1 ? 'combo' : String(layout[0] || 'option').toLowerCase(),
      optionGroupIndex: 0,
      sku: String(opt?.optionCode ?? opt?.optionNo ?? opt?.key ?? ''),
      stock: sold ? 0 : capStock(opt?.limitedQty ?? MAX_STOCK),
      isSoldout: sold,
      priceDiff: Number(opt?.sellPrice ?? 0) || 0,
    });
  }
  return out;
}

function fallbackOptions(isSoldout) {
  return [{
    optionName: 'FREE',
    optionType: 'single',
    optionGroupIndex: 0,
    sku: '',
    stock: isSoldout ? 0 : MAX_STOCK,
    isSoldout,
    priceDiff: 0,
  }];
}

function parseOptionsResponse(data, isSoldout = false) {
  const parsed = flattenOptions(data?.list || [], data?.layout || []);
  return parsed.length > 0 ? parsed : fallbackOptions(isSoldout);
}

function parseSearchItem(item, itemOptions = null) {
  const info = item?.itemInfo || {};
  const event = item?.itemEvent?.eventProperties || {};
  const sourceId = String(item?.itemId ?? event.itemNo ?? info.itemNo ?? '').trim();
  if (!sourceId) return null;

  const originalPrice = Number(info.originalPrice ?? event.consumerPrice ?? event.price ?? 0) || 0;
  const sellPrice = Number(info.displayPrice ?? event.price ?? originalPrice) || originalPrice;
  const isSoldout = info.isSoldOut === true || event.isSoldout === true;
  const options = Array.isArray(itemOptions) && itemOptions.length > 0 ? itemOptions : fallbackOptions(isSoldout);
  const totalStock = options.reduce((sum, opt) => sum + (Number(opt.stock) || 0), 0);
  const thumbnail = normalize29cmImage(info.thumbnailUrl);
  const badges = [
    ...(Array.isArray(info.textBadges) ? info.textBadges.map((badge) => badge?.text).filter(Boolean) : []),
    info.fulfillment?.promisedDeliveryDate,
  ].filter(Boolean);

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId,
    sourceUrl: `${HOST}/products/${encodeURIComponent(sourceId)}`,
    brand: String(info.brandName ?? event.brandName ?? '').trim(),
    brandName: String(info.brandName ?? event.brandName ?? '').trim(),
    originalTitle: String(info.productName ?? event.itemName ?? '').trim(),
    originalPrice,
    sellPrice,
    couponPrice: 0,
    discount: Math.max(0, originalPrice - sellPrice),
    categorySource: getCategorySource(item),
    thumbnail: thumbnail || '',
    images: thumbnail ? [thumbnail] : [],
    specs: {
      dataSource: SOURCE_MARKET,
      brandId: info.brandId ?? event.brandNo ?? null,
      largeCategoryNo: event.largeCategoryNo ?? null,
      middleCategoryNo: event.middleCategoryNo ?? null,
      smallCategoryNo: event.smallCategoryNo ?? null,
      likeCount: info.likeCount ?? null,
      badges,
    },
    options,
    totalStock,
    isSoldout: isSoldout || totalStock === 0,
    reviewScore: Number(info.reviewScore ?? 0) || null,
    reviewCount: Number(info.reviewCount ?? 0) || 0,
    storeName: '29CM',
    todayArrive: event.isDeliveryToday === true,
    benefitPrice: null,
    cardBenefitPrice: null,
    benefitDetails: badges.length ? { description: badges.join(' / '), badges } : null,
    productNotices: null,
    shippingType: badges.some((badge) => String(badge).includes('무료배송')) ? 'free' : 'paid',
    shippingFee: badges.some((badge) => String(badge).includes('무료배송')) ? 0 : null,
    sourceLeadDays: event.isDeliveryToday === true ? 1 : 2,
  };
}

function getDetailBrand(detail) {
  return String(
    detail?.frontBrand?.brandNameKor
      ?? detail?.frontBrand?.brandNameEng
      ?? detail?.brandName
      ?? '',
  ).trim();
}

function getDetailCategorySource(detail) {
  const category = Array.isArray(detail?.frontCategoryInfo) ? detail.frontCategoryInfo[0] : null;
  const path = [
    category?.category1Name,
    category?.category2Name,
    category?.category3Name,
  ].filter(Boolean);
  return path.join(' > ');
}

function getDetailImages(detail) {
  const images = Array.isArray(detail?.itemImages) ? detail.itemImages : [];
  const mainImages = uniqueStrings(images
    .filter((img) => Number(img?.imageType) === 3)
    .map((img) => normalize29cmImage(img?.imageUrl)));
  const detailImages = uniqueStrings(images
    .filter((img) => Number(img?.imageType) === 4)
    .map((img) => normalize29cmImage(img?.imageUrl)));
  const fallbackImages = uniqueStrings(images.map((img) => normalize29cmImage(img?.imageUrl)));
  return {
    mainImages: mainImages.length > 0 ? mainImages : fallbackImages,
    detailImages,
  };
}

function parseProductNotices(detail) {
  return (Array.isArray(detail?.itemDetailsList) ? detail.itemDetailsList : [])
    .map((row) => ({
      key: cleanText(row?.itemDetailsTitles ?? row?.title ?? row?.key),
      value: cleanText(row?.itemDetailsValue ?? row?.value),
    }))
    .filter((row) => row.key && row.value && row.value !== '-');
}

function extractSpecsFromNotices(notices) {
  const specs = {};
  const mappings = [
    ['material', ['소재', '주소재', '제품 주소재', '겉감']],
    ['color', ['색상', '컬러']],
    ['size', ['치수', '사이즈', '크기']],
    ['manufacturer', ['제조자', '수입자', '제조사']],
    ['origin', ['제조국', '원산지']],
    ['caution', ['취급시 주의사항', '주의사항', '세탁방법']],
    ['qualityAssuranceStandard', ['품질보증기준', '품질보증']],
    ['afterService', ['A/S 책임자', 'AS 책임자', '전화번호']],
    ['modelName', ['품번', '모델명', '모델번호']],
  ];
  for (const [specKey, keywords] of mappings) {
    const found = notices.find((notice) => {
      const key = notice.key.replace(/\s/g, '').toLowerCase();
      return keywords.some((keyword) => key.includes(keyword.replace(/\s/g, '').toLowerCase()));
    });
    if (found?.value) specs[specKey] = found.value;
  }
  return specs;
}

const SIZE_CHART_FIELDS = [
  ['shoulderWidth', '어깨너비'],
  ['chestWidth', '가슴너비'],
  ['sleeveLength', '소매길이'],
  ['shirtLength', '총장'],
  ['waistWidth', '허리너비'],
  ['hipsWidth', '엉덩이너비'],
  ['thighWidth', '허벅지너비'],
  ['hemWidth', '밑단너비'],
  ['crotchLength', '밑위'],
  ['horizontalTop', '가로상단'],
  ['horizontalBottom', '가로하단'],
  ['width', '너비'],
  ['vertical', '세로'],
  ['strapHeight', '스트랩높이'],
  ['crossStrapHeight', '크로스스트랩높이'],
];

const SHOE_SIZE_HEADERS = ['JP(cm)', 'US(M)', 'US(W)', 'UK(M)', 'UK(W)', 'EU(M)', 'EU(W)'];
const SHOE_SIZE_MAP = new Map([
  [220, ['22', '-', '5', '-', '3', '-', '36']],
  [225, ['22.5', '-', '5.5', '-', '3.5', '-', '36.5']],
  [230, ['23', '-', '6', '-', '4', '-', '37']],
  [235, ['23.5', '-', '6.5', '-', '4.5', '-', '37.5']],
  [240, ['24', '6', '7', '5', '5', '38', '38']],
  [245, ['24.5', '6.5', '7.5', '-', '5.5', '-', '38.5']],
  [250, ['25', '7', '8', '6', '6', '39', '39']],
  [255, ['25.5', '7.5', '8.5', '-', '6.5', '-', '39.5']],
  [260, ['26', '8', '9', '7', '7', '40.5', '40']],
  [265, ['26.5', '8.5', '9.5', '7.5', '7.5', '41', '40.5']],
  [270, ['27', '9', '10', '8', '8', '42', '41']],
  [275, ['27.5', '9.5', '10.5', '8.5', '8.5', '42.5', '-']],
  [280, ['28', '10', '11', '9', '9', '43', '-']],
  [285, ['28.5', '10.5', '11.5', '9.5', '-', '44', '-']],
  [290, ['29', '11', '12', '10', '-', '44.5', '-']],
  [295, ['29.5', '11.5', '-', '10.5', '-', '45', '-']],
  [300, ['30', '12', '-', '11', '-', '45.5', '-']],
  [310, ['31', '13', '-', '12', '-', '47', '-']],
]);

function parse29cmSizeTable(detail) {
  const charts = Array.isArray(detail?.itemSizeCharts) ? detail.itemSizeCharts : [];
  if (charts.length === 0) return null;

  const fields = SIZE_CHART_FIELDS.filter(([key]) =>
    charts.some((row) => {
      const value = cleanText(row?.[key]);
      return value && value !== '-';
    }),
  );
  if (fields.length === 0) return null;

  const rows = charts.map((row) => ({
    size: cleanText(row?.sizeTypeText ?? row?.sizeType ?? row?.name),
    values: fields.map(([key]) => cleanText(row?.[key])),
  })).filter((row) => row.size || row.values.some(Boolean));

  return rows.length > 0
    ? { headers: fields.map(([, label]) => label), rows, unit: 'cm' }
    : null;
}

function isShoeCategory(detail, categorySource = '') {
  const categories = Array.isArray(detail?.frontCategoryInfo) ? detail.frontCategoryInfo : [];
  const categoryText = [
    categorySource,
    ...categories.flatMap((category) => [
      category?.category1Name,
      category?.category2Name,
      category?.category3Name,
    ]),
  ].filter(Boolean).join(' ');
  return /슈즈|스니커즈|신발|shoes|sneaker/i.test(categoryText);
}

function extractShoeOptionSizes(options) {
  const sizes = [];
  for (const option of Array.isArray(options) ? options : []) {
    const name = String(option?.optionName ?? '');
    for (const match of name.matchAll(/\b(2[2-9]\d|3[01]0)\b/g)) {
      const size = Number(match[1]);
      if (SHOE_SIZE_MAP.has(size)) sizes.push(size);
    }
  }
  return [...new Set(sizes)].sort((a, b) => a - b);
}

function buildStandardShoeSizeTable(options) {
  const sizes = extractShoeOptionSizes(options);
  const source = sizes.length > 0 ? sizes : [...SHOE_SIZE_MAP.keys()];
  const rows = source.flatMap((size) => {
    const values = SHOE_SIZE_MAP.get(size);
    return values ? [{ size: String(size), values: [...values] }] : [];
  });
  return rows.length > 0 ? { headers: [...SHOE_SIZE_HEADERS], rows, unit: 'mm' } : null;
}

function extractNoticeValue(notices, ...keywords) {
  for (const notice of notices || []) {
    const key = String(notice?.key || '').replace(/\s/g, '').toLowerCase();
    if (keywords.some((keyword) => key.includes(String(keyword).replace(/\s/g, '').toLowerCase()))) {
      return cleanText(notice.value);
    }
  }
  return '';
}

function parseDescriptionSizeTable(detail) {
  const text = cleanText(detail?.itemDescriptions);
  const markerIndex = text.search(/\[?\s*SIZE\s*\]?|사이즈\s*(정보|표)?/i);
  if (markerIndex < 0) return null;

  const section = text.slice(markerIndex).replace(/^\[?\s*SIZE\s*\]?\s*/i, '');
  const rowRegex = /([A-Za-z0-9]{1,4}(?:\/[A-Za-z0-9]{1,4})?)\s*:\s*([\s\S]*?)(?=\s+[A-Za-z0-9]{1,4}(?:\/[A-Za-z0-9]{1,4})?\s*:|$)/g;
  const parsedRows = [];
  const headers = [];
  let match;
  while ((match = rowRegex.exec(section)) !== null) {
    const size = cleanText(match[1]);
    const body = cleanText(match[2]);
    if (!size || !body) continue;
    const valuesByHeader = {};
    for (const token of body.split('/')) {
      const part = cleanText(token);
      const spec = part.match(/^(.+?)\s*(?:-|:)\s*([0-9]+(?:\.[0-9]+)?\s*(?:cm|mm)?)/i);
      if (!spec) continue;
      const header = cleanText(spec[1]);
      const value = cleanText(spec[2]);
      if (!header || !value) continue;
      if (!headers.includes(header)) headers.push(header);
      valuesByHeader[header] = value;
    }
    if (Object.keys(valuesByHeader).length > 0) {
      parsedRows.push({ size, valuesByHeader });
    }
  }

  if (headers.length === 0 || parsedRows.length === 0) return null;
  return {
    headers,
    rows: parsedRows.map((row) => ({
      size: row.size,
      values: headers.map((header) => row.valuesByHeader[header] || ''),
    })),
    unit: 'cm',
  };
}

function splitSizeTokens(value) {
  return uniqueStrings(String(value || '')
    .split(/[,/|·]|\s{2,}/)
    .map((token) => cleanText(token))
    .flatMap((token) => {
      if (/^[A-Z]{1,3}\s*-\s*[A-Z]{1,3}$/i.test(token)) return token.split(/\s*-\s*/);
      return [token];
    })
    .map((token) => token.replace(/^SIZE\s*/i, '').trim())
    .filter((token) => token && !/상세|참조|참고|페이지/.test(token)));
}

function buildOptionSizeTable(options, notices = []) {
  const noticeSizes = splitSizeTokens(extractNoticeValue(notices, '치수', '사이즈', '크기'));
  const optionSizes = uniqueStrings((Array.isArray(options) ? options : [])
    .map((option) => cleanText(option?.optionName))
    .filter((name) => name && name !== 'FREE' && !/품절|sold/i.test(name)));
  const sizes = noticeSizes.length > 0 ? noticeSizes : optionSizes;
  if (sizes.length === 0) return null;
  return {
    headers: ['치수'],
    rows: sizes.map((size) => ({ size, values: ['옵션 선택'] })),
    unit: null,
  };
}

function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):?(\d{2})?:?(\d{2})?)?/);
  if (match) {
    const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return Number.isFinite(date.getTime()) ? date : null;
  }

  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function businessDaysUntil(dateLike, now = new Date()) {
  const targetDate = parseLocalDate(dateLike);
  if (!targetDate) return null;

  const today = startOfLocalDay(now);
  const target = startOfLocalDay(targetDate);
  if (target.getTime() <= today.getTime()) return 0;

  let count = 0;
  let guard = 0;
  for (
    let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    cursor.getTime() <= target.getTime() && guard < 370;
    cursor.setDate(cursor.getDate() + 1), guard += 1
  ) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function normalizeLeadDays(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  return Math.max(1, Math.ceil(n));
}

function buildDateFromMonthDay(month, day, now = new Date()) {
  const target = new Date(now.getFullYear(), Number(month) - 1, Number(day));
  if (target.getTime() < startOfLocalDay(now).getTime()) {
    target.setFullYear(target.getFullYear() + 1);
  }
  return target;
}

function parseLeadDaysFromText(text, now = new Date()) {
  const normalized = cleanText(text);
  if (!normalized) return null;

  const dateMatch = normalized.match(/(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(?:출고|발송|배송|도착)/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    const target = year
      ? new Date(Number(year), Number(month) - 1, Number(day))
      : buildDateFromMonthDay(month, day, now);
    const leadDays = normalizeLeadDays(businessDaysUntil(target, now));
    if (leadDays != null) return leadDays;
  }

  if (/당일\s*(발송|출고|배송)/.test(normalized)) return 1;
  if (/(익일|내일|다음날)\s*(배송|도착|출고|발송)/.test(normalized)) return 1;

  let match = normalized.match(/(\d{1,2})\s*(?:~|-|–|에서)\s*(\d{1,2})\s*(?:영업일|일)/);
  if (match) return normalizeLeadDays(match[2]);

  match = normalized.match(/(?:평균|주문\s*후|출고|배송|발송)?\s*(\d{1,2})\s*(?:영업일|일)\s*(?:이내|소요|출고|발송|배송)?/);
  if (match) return normalizeLeadDays(match[1]);

  return null;
}

export function resolve29cmLeadDays(detail, product = null, now = new Date()) {
  const endLead = normalizeLeadDays(businessDaysUntil(detail?.estimatedShippingEndTimestamp, now));
  if (endLead != null) return endLead;

  const beginLead = normalizeLeadDays(businessDaysUntil(detail?.estimatedShippingBeginTimestamp, now));
  if (beginLead != null) return beginLead;

  if (detail?.shippingOutType === 'SAME_DAY_SHIPPING') return 1;

  const duration = Number(detail?.shippingOutDuration);
  const durationLead = normalizeLeadDays(duration);
  if (durationLead != null && duration > 0) return durationLead;

  const textLead = parseLeadDaysFromText([
    detail?.deliveryImportantInformation,
    detail?.deliveryInfo,
    detail?.reasonForNotShipping,
    detail?.itemDescriptions,
  ].filter(Boolean).join(' '), now);
  if (textLead != null) return textLead;

  return product?.sourceLeadDays ?? 2;
}

function getDetailLeadDays(detail, product = null) {
  return resolve29cmLeadDays(detail, product);
}

function detailToSearchItem(productId, detail) {
  const id = String(productId || detail?.itemNo || '').trim();
  const brand = getDetailBrand(detail);
  return {
    itemId: id,
    itemInfo: {
      productName: detail?.itemName,
      isSoldOut: detail?.isSoldout === true || detail?.frontItemStockStatus === 'SOLD_OUT',
      originalPrice: detail?.consumerPrice,
      displayPrice: detail?.sellPrice,
      brandId: detail?.frontBrand?.frontBrandNo,
      brandName: brand,
    },
    itemEvent: {
      eventProperties: {
        itemNo: id,
        itemName: detail?.itemName,
        consumerPrice: detail?.consumerPrice,
        price: detail?.sellPrice,
        brandNo: detail?.frontBrand?.frontBrandNo,
        brandName: brand,
        isSoldout: detail?.isSoldout === true || detail?.frontItemStockStatus === 'SOLD_OUT',
      },
    },
  };
}

function applyDetailToProduct(product, detail) {
  if (!product || !detail) return product;

  const notices = parseProductNotices(detail);
  const noticeSpecs = extractSpecsFromNotices(notices);
  const { mainImages, detailImages } = getDetailImages(detail);
  const brand = getDetailBrand(detail);
  const originalPrice = asNumber(detail.consumerPrice, product.originalPrice);
  const sellPrice = asNumber(detail.sellPrice ?? detail.internalDisplayPrice, product.sellPrice || originalPrice);
  const reviewAggregation = detail.reviewAggregation || {};
  const itemDescription = cleanText(detail.itemDescriptions);
  const isFreeShipping = detail?.frontBrand?.isFreeShipping === true
    || String(detail?.deliveryInfo || '').includes('무료');
  const categorySource = getDetailCategorySource(detail) || product.categorySource;
  const apiSizeTable = parse29cmSizeTable(detail);
  const textSizeTable = parseDescriptionSizeTable(detail);
  const sizeTable = apiSizeTable
    || textSizeTable
    || (isShoeCategory(detail, categorySource) ? buildStandardShoeSizeTable(product.options) : null)
    || buildOptionSizeTable(product.options, notices);
  const isSoldout = detail?.isSoldout === true
    || detail?.frontItemStockStatus === 'SOLD_OUT'
    || product.isSoldout === true;

  const specs = {
    ...(product.specs || {}),
    ...noticeSpecs,
    dataSource: SOURCE_MARKET,
    frontBrandNo: detail?.frontBrand?.frontBrandNo ?? product.specs?.brandId ?? null,
    brandNameEng: detail?.frontBrand?.brandNameEng ?? null,
    brandNameKor: detail?.frontBrand?.brandNameKor ?? null,
    managedCategoryCode: detail?.managedCategoryInfo?.categoryCode ?? null,
    categorySource,
    discountRate: detail?.discountRate ?? product.specs?.discountRate ?? null,
    itemStockStatus: detail?.itemStockStatus ?? null,
    frontItemStockStatus: detail?.frontItemStockStatus ?? null,
  };
  if (itemDescription) specs.itemDescription = itemDescription.slice(0, 1500);

  return {
    ...product,
    brand: brand || product.brand,
    brandName: brand || product.brandName,
    originalTitle: String(detail.itemName ?? product.originalTitle ?? '').trim(),
    originalPrice,
    sellPrice,
    discount: Math.max(0, originalPrice - sellPrice),
    categorySource,
    thumbnail: mainImages[0] || product.thumbnail,
    images: mainImages.length > 0 ? mainImages : product.images,
    detailImages: detailImages.length > 0 ? detailImages : product.detailImages,
    sizeTable: sizeTable || product.sizeTable,
    specs,
    productNotices: notices.length > 0 ? notices : product.productNotices,
    reviewScore: asNumber(reviewAggregation.averagePoint, product.reviewScore),
    reviewCount: asNumber(reviewAggregation.totalCount, product.reviewCount),
    shippingType: isFreeShipping ? 'free' : product.shippingType,
    shippingFee: isFreeShipping ? 0 : product.shippingFee,
    sourceLeadDays: getDetailLeadDays(detail, product),
    isSoldout,
  };
}

async function post29cmJson(url, body, context) {
  const resp = await twentynineCmFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Referer': `${HOST}/store/search`,
      'Origin': HOST,
    },
    body: JSON.stringify(body),
  }, context);
  return resp.json();
}

export async function searchProducts(params = {}) {
  const keyword = String(params.keyword || '').trim();
  if (!keyword) return { items: [], totalCount: 0 };

  const limit = Math.max(1, Math.trunc(Number(params.limit || PAGE_SIZE) || PAGE_SIZE));
  const pageSize = Math.min(PAGE_SIZE, limit);
  const allowedBrandIds = new Set(
    (Array.isArray(params.brands) ? params.brands : [])
      .map((brand) => String(brand).trim())
      .filter(Boolean),
  );
  const items = [];
  let totalCount = 0;

  for (let page = 1; items.length < limit; page += 1) {
    const json = await post29cmJson(SEARCH_API_URL, {
      keyword,
      pageType: 'SRP',
      sortType: 'RECOMMENDED',
      facets: {},
      pageRequest: { page, size: pageSize },
    }, `search:${keyword}:${page}`);
    const rawList = Array.isArray(json?.data?.list) ? json.data.list : [];
    const list = allowedBrandIds.size > 0
      ? rawList.filter((item) => {
          const brandId = String(
            item?.itemInfo?.brandId
              ?? item?.itemEvent?.eventProperties?.brandNo
              ?? '',
          ).trim();
          return allowedBrandIds.has(brandId);
        })
      : rawList;
    totalCount = Number(json?.data?.pagination?.totalCount ?? json?.data?.pagination?.totalItemCount ?? totalCount) || totalCount;
    items.push(...list);
    if (rawList.length < pageSize) break;
    await randomDelay();
  }

  return { items: items.slice(0, limit), totalCount: totalCount || items.length };
}

/**
 * PDP detail fetch (Phase 2 — live BFF endpoint 발견 후 활성화).
 *
 * Codex Round 1 (2026-04-29) live verify: `https://www.29cm.co.kr/products/{id}`
 * 가 HTTP 404 + `self.__next_f` Flight 스트림 (App Router). `__NEXT_DATA__` 부재.
 * Phase 2 에서 BFF endpoint (e.g. `api.29cm.co.kr/...`) 발견 후 wire.
 *
 * `parseDetailFromNextData` 는 fixture 확보 후 그대로 활용 가능 — 다단계 fallback
 * key 경로가 search/brand 페이지 `dehydratedState.queries[0].state.data` 등에서도
 * 적용되는 일반 schema-flexible primitive.
 *
 * @param {string} _productId
 * @returns {Promise<never>}
 */
export async function getDetail(productId) {
  const id = String(productId || '').trim();
  if (!id) return null;
  const resp = await twentynineCmFetch(`${DETAIL_API_BASE}/${encodeURIComponent(id)}`, {
    headers: {
      'Accept': 'application/json',
      'Referer': `${HOST}/products/${encodeURIComponent(id)}`,
      'Origin': HOST,
    },
  }, `detail:${id}`);
  const json = await resp.json();
  if (json?.result && json.result !== 'SUCCESS') {
    throw new Error(`29CM detail result ${json.result}: ${id}`);
  }
  return json?.data || null;
}

/**
 * 옵션 fetch — Phase 2 (getDetail wire 후).
 *
 * @param {string} _productId
 * @returns {Promise<never>}
 */
export async function getOptions(productId) {
  const id = String(productId || '').trim();
  if (!id) return fallbackOptions(false);
  const resp = await twentynineCmFetch(`${OPTIONS_API_BASE}/${encodeURIComponent(id)}/options`, {
    headers: {
      'Accept': 'application/json',
      'Referer': `${HOST}/products/${encodeURIComponent(id)}`,
      'Origin': HOST,
    },
  }, `options:${id}`);
  const json = await resp.json();
  return parseOptionsResponse(json?.data || {}, false);
}

export async function getUpdateSnapshot(productId) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('29CM productId 필수');
  const detail = await getDetail(id);
  let itemOptions = null;
  let optionsFetchFailed = false;
  try {
    itemOptions = await getOptions(id);
  } catch (err) {
    // 2026-06-12 차단검수: getOptions 차단/실패를 삼키고 진행하면 parseSearchItem 이
    //   fallbackOptions(stock=MAX_STOCK)로 채워 잘못된 재고를 reliable 로 푸시(=fail-open).
    //   실패를 마킹해 상위(parseTwentynineCmDetail)에서 stockReliable=false 로 내린다.
    optionsFetchFailed = true;
    console.warn(`[BulkFlow] 29CM options fetch failed ${id}:`, err.message);
  }
  const snapshot = applyDetailToProduct(
    parseSearchItem(detailToSearchItem(id, detail), itemOptions),
    detail,
  );
  if (optionsFetchFailed) snapshot.__optionsFetchFailed = true;
  return snapshot;
}

/**
 * 출고소요일 — Phase 2 (getDetail wire 후 description 텍스트 휴리스틱 적용).
 * 현재는 안전한 default 2 반환 — `parseLeadDays` 자체는 fixture-free pure function.
 *
 * @param {string} _productId
 * @returns {Promise<number>}
 */
export async function getLeadDays(_productId) {
  return 2;
}

/**
 * 메인 수집 — Phase 2 활성화 대기.
 *
 * Codex Round 1 CRITICAL/HIGH: PDP App Router + search SSR PDP 링크 0건.
 * skeleton throw 패턴 유지 (PR #847 8 source 와 동일) — silent empty-success 회피.
 *
 * @param {string} _url
 * @param {number} _limit
 * @param {(progress: number, total: number, collected: number, msg?: string) => Promise<void>|void} _onProgress
 * @param {{ onBatch?: (batch: any[]) => Promise<void>|void }} _options
 * @returns {Promise<never>}
 */
export async function collect(url, limit = 100, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  const collectLimit = Math.max(1, Math.trunc(Number(limit) || 100));
  const products = [];
  let sent = 0;

  if (parsed.productId) {
    const detail = await getDetail(parsed.productId);
    let itemOptions = null;
    try {
      itemOptions = await getOptions(parsed.productId);
    } catch (err) {
      console.warn(`[BulkFlow] 29CM options fetch failed ${parsed.productId}:`, err.message);
    }
    const product = applyDetailToProduct(
      parseSearchItem(detailToSearchItem(parsed.productId, detail), itemOptions),
      detail,
    );
    if (product) products.push(product);
  } else {
    if (!parsed.keyword) {
      onProgress(100, 0, 0, '29CM URL parse failed');
      return [];
    }

    onProgress(0, 0, 0, '29CM search collection');
    const result = await searchProducts({ keyword: parsed.keyword, brands: parsed.brands || [], limit: collectLimit });
    const items = result.items;
    for (let i = 0; i < items.length; i += 1) {
      if (options?.signal?.aborted) break;
      const item = items[i];
      const sourceId = String(item?.itemId ?? item?.itemEvent?.eventProperties?.itemNo ?? '').trim();
      let itemOptions = null;
      if (sourceId) {
        let detail = null;
        try {
          detail = await getDetail(sourceId);
        } catch (err) {
          console.warn(`[BulkFlow] 29CM detail fetch failed ${sourceId}:`, err.message);
        }
        try {
          itemOptions = await getOptions(sourceId);
        } catch (err) {
          console.warn(`[BulkFlow] 29CM options fetch failed ${sourceId}:`, err.message);
        }
        item.detail = detail;
      }
      const product = applyDetailToProduct(parseSearchItem(item, itemOptions), item.detail);
      if (product) products.push(product);
      const progress = Math.min(99, Math.round(((i + 1) / Math.max(items.length, 1)) * 100));
      onProgress(progress, result.totalCount || items.length, products.length, `29CM product info ${i + 1}/${items.length}`);

      if (options?.onBatch && products.length - sent >= STREAM_BATCH) {
        await options.onBatch(products.slice(sent));
        sent = products.length;
      }
      if (i < items.length - 1) await randomDelay();
    }
  }

  if (options?.onBatch && products.length > sent) {
    await options.onBatch(products.slice(sent));
  }
  onProgress(100, products.length, products.length, '29CM collection complete');
  return products;
}

/**
 * 임시 탭 정리 — Phase 1 PoC 는 fetch 시도 자체 없음 → noop.
 * Phase 2 에서 fetchBenefitViaTab (musinsa.js 패턴) 도입 시 활성화.
 */
export function cleanupTwentynineCmTab() {
  /* noop — Phase 2 */
}
