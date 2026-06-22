const BASE_URL = 'https://www.adidas.co.kr';
const API_URL_PREFIX = `${BASE_URL}/api/products/`;
const DEFAULT_FETCH_DELAY_MS = 5000;
const STREAM_BATCH = 20;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const PDP_URL_RE = /\/([A-Z]{2}[0-9]{4}|[A-Z0-9]{5,6})\.html(?:[?#]|$)/i;
const DIRECT_MODEL_CODE_RE = /^[A-Z0-9]{5,6}$/i;
const PDP_URL_SCAN_RE = /((?:https?:\/\/(?:www\.)?adidas\.(?:co\.kr|com))?\/[^"'\\\s<>]*\/(?:[A-Z]{2}[0-9]{4}|[A-Z0-9]{5,6})\.html(?:\?[^"'\\\s<>]*)?)/gi;
const ADIDAS_HOST_RE = /(^|\.)adidas\.(co\.kr|com)$/i;
const IN_STOCK_STATUS_RE = /\b(?:in[_ -]?stock|available|orderable|low[_ -]?stock|preorder|backorder)\b/i;
const OUT_OF_STOCK_STATUS_RE = /\b(?:out[_ -]?of[_ -]?stock|sold[_ -]?out|unavailable|not[_ -]?available)\b/i;

let _lastFetchAt = 0;

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.trunc(n));
}

function pickFirstFinite(values = []) {
  for (const value of values) {
    if (value == null || value === '' || typeof value === 'boolean' || typeof value === 'object') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSku(value) {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : '';
}

function parseDiscountRate(value) {
  const match = String(value ?? '').match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeUrl(value, base = BASE_URL) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

function normalizePdpUrl(value) {
  const href = normalizeUrl(value);
  if (!href) return '';
  try {
    const url = new URL(href);
    if (!ADIDAS_HOST_RE.test(url.hostname)) return '';
    if (!extractModelCode(url.pathname)) return '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function extractModelCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const pdpMatch = text.match(PDP_URL_RE);
  if (pdpMatch?.[1]) return pdpMatch[1].toUpperCase();
  if (DIRECT_MODEL_CODE_RE.test(text)) return text.toUpperCase();
  return '';
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildCanonicalUrl(data, fallbackUrl = '') {
  const canonical = normalizePdpUrl(data?.meta_data?.canonical || data?.meta_data?.canonical_url || '');
  return canonical || normalizePdpUrl(fallbackUrl) || '';
}

function buildProductNotices(attributeList = {}) {
  const pairs = [
    ['brand', attributeList.brand],
    ['color', attributeList.color],
    ['material', attributeList.material],
    ['base_material', attributeList.base_material],
  ];

  const notices = pairs
    .map(([key, value]) => {
      if (Array.isArray(value)) value = value.filter(Boolean).join(', ');
      const normalized = String(value ?? '').trim();
      return normalized ? { key, value: normalized } : null;
    })
    .filter(Boolean);

  return notices.length > 0 ? notices : null;
}

async function throttle(signal, delayMs = DEFAULT_FETCH_DELAY_MS) {
  const waitMs = Number(delayMs);
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    _lastFetchAt = Date.now();
    return;
  }
  const elapsed = Date.now() - _lastFetchAt;
  if (elapsed >= waitMs) {
    _lastFetchAt = Date.now();
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs - elapsed);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  _lastFetchAt = Date.now();
}

async function fetchText(url, opts = {}) {
  const fetchImpl = opts?.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  await throttle(opts?.signal, opts?.delayMs);
  const res = await fetchImpl(url, {
    signal: opts?.signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Referer: `${BASE_URL}/`,
      'User-Agent': USER_AGENT,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const snippet = body.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`[adidas] HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  return body;
}

async function fetchProductData(modelCode, opts = {}) {
  const fetchImpl = opts?.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  await throttle(opts?.signal, opts?.delayMs);
  const res = await fetchImpl(`${API_URL_PREFIX}${encodeURIComponent(modelCode)}`, {
    signal: opts?.signal,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Referer: `${BASE_URL}/`,
      'User-Agent': USER_AGENT,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const snippet = body.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`[adidas] API HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('[adidas] invalid product JSON');
  }
}

async function fetchAvailabilityData(modelCode, opts = {}) {
  const fetchImpl = opts?.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  await throttle(opts?.signal, opts?.delayMs);
  const referer = normalizePdpUrl(opts?.sourceUrl) || `${BASE_URL}/`;
  const res = await fetchImpl(`${API_URL_PREFIX}${encodeURIComponent(modelCode)}/availability`, {
    signal: opts?.signal,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Referer: referer,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const snippet = body.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`[adidas] availability HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('[adidas] invalid availability JSON');
  }
}

function parseBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs)) return '';
  return breadcrumbs.map((item) => String(item?.text ?? '').trim()).filter(Boolean).join(' > ');
}

function getRecordPrice(record) {
  if (!record || typeof record !== 'object') return null;

  const pricing = isPlainObject(record?.pricing_information) ? record.pricing_information : {};
  const priceInfo = Array.isArray(record?.price_information)
    ? record.price_information
    : Array.isArray(pricing?.price_information)
      ? pricing.price_information
      : [];

  const getPriceInfoValue = (types) => {
    for (const type of types) {
      const entry = priceInfo.find((item) => String(item?.type ?? '').toLowerCase() === type);
      const value = pickFirstFinite([entry?.value, entry?.price]);
      if (value != null) return value;
    }
    return null;
  };

  return pickFirstFinite([
    pricing?.sale_price,
    pricing?.currentPrice,
    pricing?.current_price,
    record?.sale_price,
    record?.currentPrice,
    record?.current_price,
    record?.price,
    record?.value,
    getPriceInfoValue(['sale', 'current', 'discount', 'promotion']),
    pricing?.standard_price,
    record?.standard_price,
    getPriceInfoValue(['original', 'standard', 'regular']),
  ]);
}

function matchAvailabilityState(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (OUT_OF_STOCK_STATUS_RE.test(text)) return false;
  if (IN_STOCK_STATUS_RE.test(text)) return true;
  return null;
}

function hasAvailabilitySignals(record) {
  if (!record || typeof record !== 'object') return false;
  return [
    record?.orderable_count,
    record?.quantity,
    record?.available_quantity,
    record?.available_to_sell,
    record?.stock_quantity,
    record?.stock_level,
    record?.stockLevel,
    record?.stock,
    record?.ats,
    record?.availability_status,
    record?.status,
    record?.is_orderable,
    record?.orderable,
    record?.inventory,
    record?.availability,
  ].some((value) => value != null);
}

function visitAvailabilityRecords(node, records, seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((item) => visitAvailabilityRecords(item, records, seen));
    return;
  }

  const directSku = normalizeSku(
    node?.sku ?? node?.sku_id ?? node?.variation_sku ?? node?.product_id ?? node?.productId ?? node?.id,
  );
  if (directSku && hasAvailabilitySignals(node)) {
    records.push({ sku: directSku, record: node });
  }

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      visitAvailabilityRecords(value, records, seen);
      continue;
    }
    if (!isPlainObject(value)) continue;

    const keyedSku = normalizeSku(key);
    if (keyedSku && hasAvailabilitySignals(value)) {
      records.push({ sku: keyedSku, record: { sku: keyedSku, ...value } });
    }

    visitAvailabilityRecords(value, records, seen);
  }
}

function collectAvailabilityRecords(data) {
  const records = [];
  visitAvailabilityRecords(data, records);
  return records;
}

function getAvailabilityOrderable(record) {
  if (!record || typeof record !== 'object') return null;

  const directFlags = [
    record?.is_orderable,
    record?.orderable,
    record?.isOrderable,
    record?.available,
    record?.inventory?.is_orderable,
    record?.inventory?.orderable,
    record?.availability?.is_orderable,
    record?.availability?.orderable,
  ];
  for (const value of directFlags) {
    if (typeof value === 'boolean') return value;
  }

  const quantity = pickFirstFinite([
    record?.orderable_count,
    record?.quantity,
    record?.available_quantity,
    record?.available_to_sell,
    record?.stock_quantity,
    record?.stock_level,
    record?.stockLevel,
    record?.stock,
    record?.ats,
    record?.inventory?.orderable_count,
    record?.inventory?.quantity,
    record?.inventory?.available_quantity,
    record?.inventory?.available_to_sell,
    record?.availability?.orderable_count,
    record?.availability?.quantity,
    record?.availability?.available_quantity,
    record?.availability?.available_to_sell,
  ]);
  if (quantity != null) return quantity > 0;

  const states = [
    record?.availability_status,
    record?.availabilityStatus,
    record?.status,
    record?.inventory?.availability_status,
    record?.inventory?.availabilityStatus,
    record?.inventory?.status,
    record?.availability?.availability_status,
    record?.availability?.availabilityStatus,
    record?.availability?.status,
  ];
  for (const state of states) {
    const matched = matchAvailabilityState(state);
    if (matched != null) return matched;
  }

  return null;
}

function getAvailabilityStock(record) {
  if (!record || typeof record !== 'object') return null;

  const quantity = pickFirstFinite([
    record?.orderable_count,
    record?.quantity,
    record?.available_quantity,
    record?.available_to_sell,
    record?.stock_quantity,
    record?.stock_level,
    record?.stockLevel,
    record?.stock,
    record?.ats,
    record?.inventory?.orderable_count,
    record?.inventory?.quantity,
    record?.inventory?.available_quantity,
    record?.inventory?.available_to_sell,
    record?.inventory?.stock_quantity,
    record?.inventory?.stock_level,
    record?.inventory?.stockLevel,
    record?.inventory?.stock,
    record?.availability?.orderable_count,
    record?.availability?.quantity,
    record?.availability?.available_quantity,
    record?.availability?.available_to_sell,
    record?.availability?.stock_quantity,
    record?.availability?.stock_level,
    record?.availability?.stockLevel,
    record?.availability?.stock,
  ]);
  if (quantity != null) return Math.max(0, Math.trunc(quantity));

  const orderable = getAvailabilityOrderable(record);
  if (orderable != null) return orderable ? 10 : 0;
  return null;
}

function buildAvailabilityIndex(data) {
  const index = new Map();

  for (const entry of collectAvailabilityRecords(data)) {
    const sku = normalizeSku(entry?.sku);
    if (!sku) continue;

    const stock = normalizeInteger(getAvailabilityStock(entry.record));
    const price = getRecordPrice(entry.record);
    const orderable = getAvailabilityOrderable(entry.record);
    const previous = index.get(sku) || {};

    index.set(sku, {
      stock: stock ?? previous.stock ?? null,
      price: price ?? previous.price ?? null,
      orderable: orderable ?? previous.orderable ?? null,
    });
  }

  return index;
}

export function getOptions(detailOrData, availabilityData = null) {
  if (Array.isArray(detailOrData?.options)) {
    return detailOrData.options.map((option) => ({
      optionName: option.optionName ?? '',
      sku: option.sku ?? '',
      stock: normalizeNumber(option.stock, 0),
      isSoldout: !!option.isSoldout,
      priceDiff: normalizeNumber(option.priceDiff, 0),
      __stockFromAvailability: option.__stockFromAvailability === true,
    }));
  }

  const variationList = Array.isArray(detailOrData?.variation_list) ? detailOrData.variation_list : [];
  const productOrderable = detailOrData?.attribute_list?.is_orderable;
  const basePrice = getRecordPrice(detailOrData);
  const availabilityIndex = availabilityData ? buildAvailabilityIndex(availabilityData) : new Map();

  return variationList.map((variation) => {
    const isOrderable = variation?.is_orderable ?? productOrderable ?? true;
    const sku = normalizeSku(variation?.sku);
    const availability = sku ? availabilityIndex.get(sku) : null;
    const fallbackStock = isOrderable ? 10 : 0;
    const resolvedStock = normalizeInteger(availability?.stock);
    const stock = resolvedStock != null ? resolvedStock : fallbackStock;
    const optionPrice = getRecordPrice(variation) ?? availability?.price ?? null;
    const priceDiff = basePrice != null && optionPrice != null ? optionPrice - basePrice : 0;

    return {
      optionName: String(variation?.size ?? '').trim(),
      sku,
      stock,
      isSoldout: stock <= 0,
      priceDiff: Number.isFinite(priceDiff) ? priceDiff : 0,
      // 재고가 실제 availability(SKU별 수량)에서 resolved 됐을 때만 true. fallback(10/0) 이면 false.
      __stockFromAvailability: resolvedStock != null,
    };
  });
}

export function getLeadDays(_detail = null) {
  return null;
}

function mapProduct(data, hint = {}) {
  const attributeList = data?.attribute_list || {};
  const pricing = data?.pricing_information || data?.price_information || {};
  const images = Array.isArray(data?.view_list)
    ? data.view_list.map((item) => normalizeUrl(item?.image_url)).filter(Boolean)
    : [];
  const options = getOptions(data, hint?.availabilityData);
  const totalStock = options.reduce((sum, option) => sum + normalizeNumber(option.stock, 0), 0);
  const isOrderable = attributeList?.is_orderable ?? true;
  const leadDays = getLeadDays(data);
  // availability fetch 가 성공했고(=hint.availabilityData 존재) 모든 옵션 재고가 실제 availability 에서 왔을 때만 신뢰.
  // 하나라도 fallback(phantom 10/0) 이면 false → 업데이트 경로에서 재고 푸시 차단(오버셀링 방지).
  const availabilityReliable =
    hint?.availabilityData != null &&
    options.length > 0 &&
    options.every((option) => option.__stockFromAvailability === true);

  return {
    sourceMarket: 'adidas',
    sourceId: String(data?.id || hint?.modelCode || ''),
    sourceUrl: buildCanonicalUrl(data, hint?.sourceUrl),
    brand: String(attributeList?.brand ?? ''),
    originalTitle: String(data?.name ?? ''),
    originalPrice: normalizeNumber(pricing?.standard_price, 0),
    sellPrice: normalizeNumber(pricing?.sale_price ?? pricing?.currentPrice ?? pricing?.standard_price, 0),
    couponPrice: 0,
    discount: parseDiscountRate(pricing?.discount_text),
    categorySource: parseBreadcrumbs(data?.breadcrumb_list),
    thumbnail: images[0] || '',
    images,
    specs: {
      ...(data?.brand_id ? { brandId: String(data.brand_id) } : {}),
      ...(data?.base_model_number ? { productCode: String(data.base_model_number) } : {}),
      ...(data?.model_number ? { modelNumber: String(data.model_number) } : {}),
    },
    options,
    totalStock,
    __availabilityReliable: availabilityReliable,
    isSoldout: options.length > 0 ? options.every((option) => option.isSoldout) : !isOrderable,
    reviewScore: 0,
    reviewCount: 0,
    storeName: 'adidas',
    todayArrive: false,
    benefitPrice: null,
    cardBenefitPrice: null,
    benefitDetails: null,
    productNotices: buildProductNotices(attributeList),
    shippingType: 'paid',
    shippingFee: null,
    ...(leadDays != null ? { sourceLeadDays: leadDays } : {}),
  };
}

function extractPdpUrlsFromListingHtml(html, limit = 10000) {
  const normalizedHtml = decodeHtmlEntities(html);
  const seen = new Set();
  const urls = [];
  let match;

  while ((match = PDP_URL_SCAN_RE.exec(normalizedHtml)) !== null) {
    const href = normalizePdpUrl(match[1]);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
    if (urls.length >= limit) break;
  }

  return urls;
}

async function collectListingPdpUrls(url, limit, opts = {}) {
  // Live listing API discovery could not be verified in this environment because
  // adidas blocks the agent with WAF 403. Fallback: fetch listing HTML and
  // collect PDP hrefs directly.
  const html = await fetchText(url, opts);
  return extractPdpUrlsFromListingHtml(html, limit);
}

export function parseUrl(url) {
  const raw = String(url ?? '').trim();
  const modelCode = extractModelCode(raw);
  let normalizedUrl = raw;
  let isListingUrl = false;

  if (isHttpUrl(raw)) {
    normalizedUrl = new URL(raw).href;
    isListingUrl = !modelCode;
  }

  return {
    url: normalizedUrl,
    modelCode,
    isProductUrl: !!modelCode,
    isListingUrl,
  };
}

export async function getDetail(input, opts = {}) {
  const parsed = typeof input === 'object' && input != null
    ? {
        url: String(input.url ?? input.sourceUrl ?? ''),
        modelCode: extractModelCode(input.modelCode || input.url || input.sourceUrl || ''),
      }
    : parseUrl(input);

  if (!parsed.modelCode) {
    throw new Error('adidas modelCode required');
  }

  const data = await fetchProductData(parsed.modelCode, opts);
  let availabilityData = null;
  try {
    availabilityData = await fetchAvailabilityData(parsed.modelCode, {
      ...opts,
      sourceUrl: parsed.url || opts?.sourceUrl || '',
    });
  } catch (error) {
    console.warn(`[adidas] availability failed for ${parsed.modelCode}:`, error?.message || error);
  }

  return mapProduct(data, {
    modelCode: parsed.modelCode,
    sourceUrl: parsed.url || opts?.sourceUrl || '',
    availabilityData,
  });
}

export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const maxItems = Math.max(0, Number(limit) || 0);
  const parsed = parseUrl(url);

  if (maxItems <= 0) {
    progress(100, 0, 0, 'adidas limit 0');
    return [];
  }

  if (parsed.isProductUrl) {
    progress(0, 1, 0, 'adidas PDP fetch');
    const product = await getDetail(parsed, options);
    if (options?.onBatch) await options.onBatch([product]);
    progress(100, 1, 1, 'adidas collection complete');
    return [product];
  }

  if (!parsed.isListingUrl) {
    progress(100, 0, 0, 'adidas listing URL required');
    return [];
  }

  progress(0, 0, 0, 'adidas listing fetch');
  const pdpUrls = await collectListingPdpUrls(parsed.url, maxItems, options);
  if (pdpUrls.length === 0) {
    progress(100, 0, 0, 'adidas listing fallback found no PDP URLs');
    return [];
  }

  const products = [];
  let batch = [];
  let sent = 0;
  const total = Math.min(pdpUrls.length, maxItems);

  for (let index = 0; index < total; index++) {
    if (options?.signal?.aborted) break;
    const pdpUrl = pdpUrls[index];
    try {
      const product = await getDetail({ url: pdpUrl, sourceUrl: pdpUrl }, options);
      products.push(product);
      batch.push(product);
      sent += 1;
      if (batch.length >= STREAM_BATCH && options?.onBatch) {
        await options.onBatch(batch);
        batch = [];
      }
    } catch (error) {
      console.warn(`[adidas] detail failed for ${pdpUrl}:`, error?.message || error);
    }

    const percent = Math.min(99, Math.round(((index + 1) / total) * 100));
    progress(percent, total, sent, `adidas PDP ${index + 1}/${total}`);
  }

  if (batch.length > 0 && options?.onBatch) {
    await options.onBatch(batch);
  }

  progress(100, total, sent, 'adidas collection complete');
  return products;
}

export function cleanupAdidasTab() {
  // Fetch-only collector; no transient tab to clean up.
}
