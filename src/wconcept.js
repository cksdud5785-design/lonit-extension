// WConcept (wconcept.co.kr) collector.
//
// Scope:
//   - extension-side search collection through WConcept display API
//   - fixture-backed PDP parser fallback
//   - hard abort on access-control/challenge signals

export const SOURCE_WCONCEPT_POC_ENABLED = true;

const BASE_URL = 'https://www.wconcept.co.kr';
const PDP_URL_PREFIX = `${BASE_URL}/Product/`;
const DISPLAY_BASE_URL = 'https://display.wconcept.co.kr';
const DISPLAY_API_URL = 'https://api-display.wconcept.co.kr/display/api/v3/search/result/product';
const DISPLAY_API_KEY = 'VWmkUPgs6g2fviPZ5JQFQ3pERP4tIXv/J2jppLqSRBk=';
const ABORT_STATUSES = new Set([403, 429, 451]);
const ABORT_BODY_RE = /\b(captcha|perimeterx|cloudflare-challenge|akamai)\b/i;
const SEARCH_PAGE_SIZE = 60;
const STREAM_BATCH = 50;
const SEARCH_DELAY_MS = 500;
const ALLOWED_HOSTS = new Set([
  'www.wconcept.co.kr',
  'wconcept.co.kr',
  'display.wconcept.co.kr',
  'm.wconcept.co.kr',
]);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let _lastSearchFetchAt = 0;

export class WconceptAbortError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'WconceptAbortError';
    this.sourceMarket = 'wconcept';
    this.abort = true;
    if (meta.status != null) this.status = meta.status;
    if (meta.trigger) this.trigger = meta.trigger;
  }
}

function isEnabled(options = {}) {
  return options?.sourceWconceptPocEnabled === true
    || globalThis.SOURCE_WCONCEPT_POC_ENABLED === true
    || SOURCE_WCONCEPT_POC_ENABLED === true;
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function textFromHtml(value) {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractByClass(html, tag, className) {
  const re = new RegExp(
    `<${tag}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? textFromHtml(match[1]) : '';
}

function extractAttr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = String(attrs || '').match(re);
  return match ? decodeEntities(match[1]).trim() : '';
}

function parseWon(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseLeadDays(text) {
  const match = String(text ?? '').match(/(\d+)\s*일/);
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : null;
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUrl(raw, base = BASE_URL) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function parseCsvNumbers(value) {
  return String(value ?? '')
    .split(',')
    .map((v) => Number(String(v).trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
}

async function searchThrottle() {
  const now = Date.now();
  const elapsed = now - _lastSearchFetchAt;
  if (elapsed < SEARCH_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS - elapsed));
  }
  _lastSearchFetchAt = Date.now();
}

function extractNextData(html) {
  const text = String(html ?? '');
  const marker = '__NEXT_DATA__';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('>', markerIndex);
  const end = text.indexOf('</script>', markerIndex);
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start + 1, end));
  } catch {
    return null;
  }
}

function parseInitialSearchContext(html) {
  const nextData = extractNextData(html);
  const pageProps = nextData?.props?.pageProps || {};
  return {
    refererSource: pageProps.initialData?.refererSource || 'HOME',
    gender: String(pageProps.genderType || 'all').toLowerCase(),
  };
}

/**
 * Throw when a response status is legally/rate/blocking sensitive.
 *
 * @param {{ status?: number }} response
 */
export function assertWconceptResponseAllowed(response) {
  const status = Number(response?.status);
  if (ABORT_STATUSES.has(status)) {
    throw new WconceptAbortError(`[W컨셉] abort: HTTP ${status}`, {
      status,
      trigger: `HTTP ${status}`,
    });
  }
}

/**
 * Throw when a body contains bot/challenge markers.
 *
 * @param {string} body
 */
export function assertWconceptBodyAllowed(body) {
  const text = String(body ?? '');
  const match = text.match(ABORT_BODY_RE);
  if (match) {
    throw new WconceptAbortError(`[W컨셉] abort: challenge body marker (${match[1]})`, {
      trigger: match[1].toLowerCase(),
    });
  }
}

/**
 * Extension-side HTML fetch helper. Default collect path never calls this while
 * SOURCE_WCONCEPT_POC_ENABLED remains false.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} opts
 * @returns {Promise<string>}
 */
export async function fetchWconceptHtml(url, opts = {}) {
  const res = await fetch(url, {
    signal: opts?.signal,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'User-Agent': USER_AGENT,
    },
  });
  assertWconceptResponseAllowed(res);
  if (!res.ok) throw new Error(`[W컨셉] HTTP ${res.status}`);
  const html = await res.text();
  assertWconceptBodyAllowed(html);
  return html;
}

/**
 * URL → PDP product id.
 *
 * @param {string} url
 * @returns {{ productId: string, url: string }}
 */
export function parseUrl(url) {
  const result = {
    productId: '',
    keyword: '',
    brandIds: [],
    topBrandIds: [],
    type: '',
    url: String(url ?? ''),
  };
  if (!url || typeof url !== 'string') return result;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return result;
    const fromQuery = parsed.searchParams.get('productId') || parsed.searchParams.get('itemId') || parsed.searchParams.get('itemCd');
    const fromPath = parsed.pathname.match(/(\d{6,})/)?.[1] || '';
    result.productId = fromQuery || fromPath;
    result.keyword = (parsed.searchParams.get('keyword') || parsed.searchParams.get('q') || '').trim();
    result.brandIds = parseCsvNumbers(parsed.searchParams.get('brand'));
    result.topBrandIds = parseCsvNumbers(parsed.searchParams.get('topBrand'));
    result.type = parsed.searchParams.get('type') || (result.keyword ? 'direct' : '');
  } catch {
    result.productId = String(url).match(/(\d{6,})/)?.[1] || '';
    if (!result.productId && String(url).length < 100) {
      result.keyword = String(url).trim();
      result.type = 'direct';
    }
  }
  return result;
}

/**
 * W컨셉 mock/PDP HTML parser.
 *
 * @param {string} html
 * @returns {{
 *   source: string,
 *   productId: string,
 *   title: string,
 *   sellPrice: number|null,
 *   benefitPrice: number|null,
 *   cardPromotion: string,
 *   options: Array<{ optionName: string, optionType: string, sku: string, stock: number, isSoldout: boolean, priceDiff: number }>,
 *   images: string[],
 *   shipping: { text: string, leadDays: number|null },
 *   rawHtml: string,
 * }}
 */
export function parseDetailHtml(html) {
  const rawHtml = typeof html === 'string' ? html : '';
  if (!rawHtml) {
    return {
      source: '',
      productId: '',
      title: '',
      sellPrice: null,
      benefitPrice: null,
      cardPromotion: '',
      options: [],
      images: [],
      shipping: { text: '', leadDays: null },
      rawHtml: '',
    };
  }

  assertWconceptBodyAllowed(rawHtml);

  const source = extractAttr(rawHtml.match(/<[^>]*data-source=["'][^"']+["'][^>]*>/i)?.[0] || '', 'data-source');
  const productId = extractAttr(rawHtml.match(/<[^>]*data-product-id=["'][^"']+["'][^>]*>/i)?.[0] || '', 'data-product-id');
  const title = textFromHtml(rawHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const sellPrice = parseWon(extractByClass(rawHtml, 'span', 'sell-price'));
  const benefitPrice = parseWon(extractByClass(rawHtml, 'span', 'benefit-price'));
  const cardPromotion = extractByClass(rawHtml, 'div', 'card-promo');
  const shippingText = extractByClass(rawHtml, 'p', 'shipping');

  const options = [];
  const selectMatch = rawHtml.match(/<select\b[^>]*>([\s\S]*?)<\/select>/i);
  if (selectMatch) {
    const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRe.exec(selectMatch[1])) !== null) {
      const optionName = textFromHtml(match[2]);
      if (!optionName) continue;
      options.push({
        optionName,
        optionType: /^(XS|S|M|L|XL|XXL|FREE|F|\d{2,3})$/i.test(optionName) ? 'size' : 'mixed',
        sku: extractAttr(match[1], 'value'),
        stock: 0,
        isSoldout: false,
        priceDiff: 0,
      });
    }
  }

  const images = [];
  const seenImages = new Set();
  const imgRe = /<img\b([^>]*)>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(rawHtml)) !== null) {
    const url = normalizeUrl(extractAttr(imgMatch[1], 'src') || extractAttr(imgMatch[1], 'data-src'));
    if (!url || seenImages.has(url)) continue;
    seenImages.add(url);
    images.push(url);
  }

  return {
    source,
    productId,
    title,
    sellPrice,
    benefitPrice,
    cardPromotion,
    options,
    images,
    shipping: {
      text: shippingText,
      leadDays: parseLeadDays(shippingText),
    },
    rawHtml,
  };
}

/**
 * PDP product fetch + parse.
 *
 * @param {string|number} productId
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function getDetail(productId, opts = {}) {
  if (!productId) throw new Error('productId 필수');
  const html = await fetchWconceptHtml(`${PDP_URL_PREFIX}${encodeURIComponent(String(productId))}`, opts);
  return parseDetailHtml(html);
}

function buildSearchPayload(parsed, pageNo, pageSize, context = {}) {
  const brandCodes = parsed.topBrandIds?.length ? parsed.topBrandIds : parsed.brandIds || [];
  return {
    custNo: '',
    gender: context.gender || 'all',
    keyword: parsed.keyword || '',
    sort: 'WCK',
    pageNo,
    pageSize,
    bcds: brandCodes,
    lcds: [],
    colors: [],
    benefits: [],
    discounts: [],
    status: ['01'],
    source: context.refererSource || 'HOME',
    device: 'PC',
    searchType: parsed.type || 'direct',
    domainType: 'pc',
  };
}

async function fetchWconceptSearchPage(parsed, pageNo, pageSize, opts = {}) {
  await searchThrottle();
  const context = opts.context || {};
  const payload = buildSearchPayload(parsed, pageNo, pageSize, context);
  const res = await fetch(DISPLAY_API_URL, {
    method: 'POST',
    signal: opts?.signal,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Content-Type': 'application/json; charset=UTF-8',
      'DISPLAY-API-KEY': DISPLAY_API_KEY,
      'User-Agent': USER_AGENT,
      Referer: `${DISPLAY_BASE_URL}/`,
      deviceType: 'PC',
      CUST_NO: '',
    },
    credentials: 'omit',
    body: JSON.stringify(payload),
  });

  assertWconceptResponseAllowed(res);
  const text = await res.text();
  assertWconceptBodyAllowed(text);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`[Wconcept] invalid search JSON (${res.status})`);
  }
  if (!res.ok || json?.result !== 'SUCCESS') {
    throw new Error(`[Wconcept] search API ${res.status}: ${json?.message || 'failed'}`);
  }
  return json?.data?.productList || { content: [], totalPages: 0, totalElements: 0, number: pageNo };
}

/**
 * WConcept search result API fetch.
 *
 * @param {{ parsed?: ReturnType<typeof parseUrl>, url?: string, limit?: number, signal?: AbortSignal, onProgress?: Function }} params
 * @returns {Promise<{ items: Array<any>, totalCount: number }>}
 */
export async function searchProducts(params = {}) {
  const parsed = params.parsed || parseUrl(params.url || '');
  const limit = Math.max(0, Number(params.limit ?? SEARCH_PAGE_SIZE));
  if (!parsed.keyword && !parsed.brandIds?.length && !parsed.topBrandIds?.length) {
    return { items: [], totalCount: 0 };
  }

  let context = {};
  try {
    const html = await fetchWconceptHtml(parsed.url, { signal: params.signal });
    context = parseInitialSearchContext(html);
  } catch {
    context = { refererSource: 'HOME', gender: 'all' };
  }

  const items = [];
  let totalCount = 0;
  let totalPages = 1;
  let pageNo = 1;

  while (items.length < limit && pageNo <= totalPages) {
    const page = await fetchWconceptSearchPage(parsed, pageNo, Math.min(SEARCH_PAGE_SIZE, Math.max(1, limit - items.length)), {
      signal: params.signal,
      context,
    });
    const content = Array.isArray(page.content) ? page.content : [];
    totalCount = Number(page.totalElements ?? totalCount ?? content.length) || content.length;
    totalPages = Math.max(1, Number(page.totalPages ?? totalPages) || 1);
    items.push(...content);
    if (typeof params.onProgress === 'function') {
      const progress = Math.min(95, Math.round((items.length / Math.max(limit, Math.min(totalCount || limit, limit))) * 95));
      params.onProgress(progress, totalCount || items.length, items.length, `WConcept search page ${pageNo}`);
    }
    if (content.length === 0) break;
    pageNo += 1;
  }

  return { items: items.slice(0, limit), totalCount };
}

/**
 * Stage 1 options are parsed from PDP HTML. A parsed detail object may be passed
 * directly by tests or future collect code.
 */
export async function getOptions(detailOrProductId) {
  if (detailOrProductId && typeof detailOrProductId === 'object') {
    return Array.isArray(detailOrProductId.options) ? detailOrProductId.options : [];
  }
  return [];
}

export function getLeadDays(detail = null) {
  const days = detail?.shipping?.leadDays;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Parsed PDP detail → standard source product shape.
 *
 * @param {ReturnType<typeof parseDetailHtml>} detail
 * @param {{ sourceUrl?: string, productId?: string }} [hint]
 */
export function parseItem(detail, hint = {}) {
  const productId = String(hint?.productId || detail?.productId || '');
  const images = Array.isArray(detail?.images) ? detail.images : [];
  const options = Array.isArray(detail?.options) ? detail.options : [];
  const leadDays = getLeadDays(detail);

  return {
    sourceMarket: 'wconcept',
    sourceId: productId,
    sourceUrl: hint?.sourceUrl || (productId ? `${PDP_URL_PREFIX}${productId}` : ''),
    brand: '',
    originalTitle: detail?.title || '',
    originalPrice: detail?.sellPrice ?? 0,
    sellPrice: detail?.sellPrice ?? 0,
    couponPrice: 0,
    discount: 0,
    categorySource: '',
    thumbnail: images[0] || '',
    images,
    specs: {
      ...(detail?.cardPromotion ? { cardPromotion: detail.cardPromotion } : {}),
      ...(detail?.source ? { dataSource: detail.source } : {}),
    },
    options,
    totalStock: 0,
    isSoldout: false,
    reviewScore: 0,
    reviewCount: 0,
    storeName: 'W컨셉',
    todayArrive: false,
    benefitPrice: detail?.benefitPrice ?? null,
    cardBenefitPrice: null,
    benefitDetails: detail?.cardPromotion || null,
    // 2026-05-18: 정보고시 — W컨셉 PDP detail 표준 필드.
    productNotices: {
      manufacturer: String(detail?.brand || 'W컨셉'),
      importer: '주식회사 더블유컨셉코리아',
      manufactureCountry: '상세설명 참조',
      material: String(detail?.material || '상세설명 참조'),
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'W컨셉 고객센터 1644-3777',
    },
    shippingType: 'paid',
    shippingFee: null,
    ...(leadDays != null ? { sourceLeadDays: leadDays } : {}),
  };
}

export function parseSearchItem(item) {
  const sourceId = String(item?.itemCd ?? '').trim();
  const imageUrl = normalizeUrl(item?.imageUrlMobile || item?.imageUrl || '');
  const originalPrice = parseNumber(item?.customerPrice ?? item?.salePrice ?? item?.finalPrice, 0);
  const sellPrice = parseNumber(item?.finalPrice ?? item?.salePrice ?? item?.customerPrice, originalPrice);
  const salePrice = parseNumber(item?.salePrice ?? sellPrice, sellPrice);
  const isSoldout = String(item?.statusCd ?? '') !== '01';
  const titlePrefix = String(item?.itemNameSub || item?.itemNameFront || '').trim();
  const title = [titlePrefix, item?.itemName].filter(Boolean).join(' ').trim();
  const categorySource = [
    item?.mediumName,
    item?.categoryDepthName1,
    item?.categoryDepthName2,
    item?.categoryDepthName3,
  ].filter(Boolean).join(' > ');
  const stock = isSoldout ? 0 : 99;

  return {
    sourceMarket: 'wconcept',
    sourceId,
    sourceUrl: sourceId ? `${PDP_URL_PREFIX}${sourceId}` : '',
    brand: item?.brandNameEn || item?.brandNameKr || '',
    brandName: item?.brandNameKr || '',
    originalTitle: title,
    originalPrice,
    sellPrice,
    couponPrice: 0,
    discount: parseNumber(item?.finalDiscountRate, 0),
    categorySource,
    thumbnail: imageUrl,
    images: imageUrl ? [imageUrl] : [],
    specs: {
      brandCd: item?.brandCd ?? null,
      statusCd: item?.statusCd ?? null,
      itemTypeCd: item?.itemTypeCd ?? null,
      webViewUrl: item?.webViewUrl ?? null,
      reviewScore: item?.reviewScore ?? null,
      reviewCount: item?.reviewCnt ?? null,
      heartCount: item?.heartCnt ?? null,
      infoTags: item?.infoTags ?? [],
      saleTag: item?.saleTag ?? null,
      finalDiscountRate: item?.finalDiscountRate ?? null,
      customerPrice: item?.customerPrice ?? null,
      salePrice: item?.salePrice ?? null,
      finalPrice: item?.finalPrice ?? null,
      todayDeliveryTag: item?.todayDeliveryTag ?? false,
    },
    options: sourceId ? [{
      optionName: 'default',
      optionType: 'default',
      sku: sourceId,
      stock,
      isSoldout,
      priceDiff: 0,
    }] : [],
    totalStock: stock,
    isSoldout,
    reviewScore: parseNumber(item?.reviewScore, 0),
    reviewCount: parseNumber(item?.reviewCnt, 0),
    storeName: 'WConcept',
    todayArrive: !!item?.todayDeliveryTag,
    benefitPrice: sellPrice !== salePrice ? sellPrice : null,
    cardBenefitPrice: null,
    benefitDetails: item?.infoTags?.length ? { infoTags: item.infoTags } : null,
    // 2026-05-18: 정보고시 (search item minimal)
    productNotices: {
      importer: '주식회사 더블유컨셉코리아',
      manufactureCountry: '상세설명 참조',
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'W컨셉 고객센터 1644-3777',
    },
    shippingType: 'paid',
    shippingFee: null,
    ...(item?.todayDeliveryTag ? { sourceLeadDays: 1 } : {}),
  };
}

/**
 * W컨셉 PDP Stage 1 collect.
 *
 * Default OFF: returns [] and performs no fetch unless SOURCE_WCONCEPT_POC_ENABLED
 * is explicitly enabled by caller/global test harness.
 */
export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  if (!isEnabled(options)) {
    onProgress(100, 0, 0, 'W컨셉 PoC 비활성화');
    return [];
  }

  const parsed = parseUrl(url);
  if (limit <= 0) {
    onProgress(100, 0, 0, 'WConcept limit 0');
    return [];
  }

  if (parsed.keyword || parsed.brandIds?.length || parsed.topBrandIds?.length) {
    onProgress(0, 0, 0, 'WConcept search collection');
    const result = await searchProducts({
      parsed,
      limit,
      signal: options?.signal,
      onProgress,
    });
    const products = result.items
      .map((item) => parseSearchItem(item))
      .filter((item) => item.sourceId && item.originalTitle);

    if (options?.onBatch) {
      for (let i = 0; i < products.length; i += STREAM_BATCH) {
        await options.onBatch(products.slice(i, i + STREAM_BATCH));
      }
    }
    onProgress(100, result.totalCount || products.length, products.length, 'WConcept collection complete');
    return products;
  }

  if (!parsed.productId) {
    onProgress(100, 0, 0, 'W컨셉 PDP 없음');
    return [];
  }

  onProgress(0, 1, 0, 'W컨셉 PDP 파싱중...');
  const detail = await getDetail(parsed.productId, { signal: options?.signal });
  const product = parseItem(detail, { sourceUrl: parsed.url, productId: parsed.productId });
  const batch = [product];

  if (options?.onBatch) await options.onBatch(batch);
  onProgress(100, 1, 1, '수집 완료');
  return batch;
}

export function cleanupWconceptTab() {
  // Stage 1 uses no tab resources.
}
