/**
 * 목적: Gmarket + Auction + StarDelivery unified parser — windowCollector PoC.
 *
 * 사이트 특성:
 *   - Gmarket / Auction 는 더망고 기준 동일 collector 로 처리
 *   - PDP URL: Gmarket /item, /n/item / Auction itempage.auction.co.kr 또는 /item/{id}
 *   - 404 sentinel: not_found.html / goodsNotFound URL 패턴
 *   - 상세는 outerHTML + iframe innerHTML(extraHtml) 병합 가능
 *   - 목록은 StarDelivery / minishop / general card selector 분기
 *
 * Contract (window-collector.js 와 일치):
 *   parse(html, url, extraHtml) → Product[]
 *
 * Strategy:
 *   - service worker 환경 (DOMParser 없음) — regex + JSON.parse 만 사용
 *   - 404 URL sentinel 우선 처리
 *   - PDP 는 inline JSON(window.__ESM_DATA__ / __GS_DATA__) 우선, title/img regex fallback
 *   - 목록은 anchor/card chunk 를 regex 로 순회해서 최소 Product 추출
 *
 * Fixture:
 *   src/__tests__/__fixtures__/gmarket/pdp_with_iframe.html
 *   src/__tests__/__fixtures__/gmarket/star_delivery.html
 */

const SOURCE_MARKET = 'gmarket';
const PDP_URL_RE = /\/(?:n\/)?item(?:[/?#]|$)/i;
const AUCTION_PATH_PDP_RE = /\/item\/([0-9A-Za-z]+)(?:[/?#]|$)/i;
const SCRIPT_JSON_RES = [
  /window\.__ESM_DATA__\s*=\s*({[\s\S]*?})\s*;/i,
  /window\.__GS_DATA__\s*=\s*({[\s\S]*?})\s*;/i,
  /const\s+__ESM_DATA__\s*=\s*({[\s\S]*?})\s*;/i,
  /const\s+__GS_DATA__\s*=\s*({[\s\S]*?})\s*;/i,
];

/**
 * @param {string} html       - document.documentElement.outerHTML
 * @param {string} url        - 페이지 URL
 * @param {string|null} extraHtml - #detail1 / #hIfrmExplainView iframe body innerHTML
 * @returns {Promise<Array>}  - Lonit Product shape
 */
export async function parse(html, url, extraHtml) {
  if (isNotFoundUrl(url)) {
    const deletedExternalId = extractExternalId(url, html);
    return deletedExternalId
      ? [{ deletedExternalId, sourceMarket: SOURCE_MARKET }]
      : [];
  }

  if (isStarDeliveryUrl(url)) {
    return parseList(html, url);
  }

  if (isAuctionPdpUrl(url) || isGmarketPdpUrl(url)) {
    const detail = parseDetail(html, url, extraHtml);
    return detail ? [detail] : [];
  }

  if (isMinishopUrl(url)) {
    return parseList(html, url);
  }

  return parseList(html, url);
}

function isNotFoundUrl(url) {
  const lowered = String(url || '').toLowerCase();
  return lowered.includes('not_found.html') || lowered.includes('goodsnotfound');
}

function isStarDeliveryUrl(url) {
  const lowered = String(url || '').toLowerCase();
  return lowered.includes('/star-delivery') || lowered.includes('stardelevery');
}

function isMinishopUrl(url) {
  const host = getUrlHost(url);
  return host.includes('stores.auction') || host.includes('minishop.gmarket');
}

function isAuctionPdpUrl(url) {
  const host = getUrlHost(url);
  const pathname = getUrlPathname(url);
  return host === 'itempage.auction.co.kr' || (host.includes('auction.co.kr') && AUCTION_PATH_PDP_RE.test(pathname));
}

function isGmarketPdpUrl(url) {
  const host = getUrlHost(url);
  const pathname = getUrlPathname(url);
  if (!host.includes('gmarket.co.kr')) return false;
  if (host.includes('minishop.gmarket.co.kr')) return false;
  return PDP_URL_RE.test(pathname);
}

function parseDetail(html, url, extraHtml) {
  const rawData = extractInlineJson(html) || {};
  const detail = pickDetailNode(rawData);
  const externalId = readFirst(
    detail.goodsCode,
    detail.itemId,
    detail.itemNo,
    detail.goodsNo,
    extractExternalId(url, html),
  );
  const title = cleanText(readFirst(detail.goodsName, detail.title, extractTitle(html)));
  const brand = cleanText(readFirst(detail.brandName, detail.brand, detail.sellerBrandName, ''));
  const price = toNumber(
    readFirst(
      detail.sellPrice,
      detail.salePrice,
      detail.price?.sell,
      detail.price?.sale,
      detail.price,
      detail.priceInfo?.sellPrice,
      detail.discountPrice,
    ),
  );
  const originalPrice = toNumber(
    readFirst(
      detail.originalPrice,
      detail.listPrice,
      detail.price?.original,
      detail.price?.list,
      detail.priceInfo?.originalPrice,
      detail.priceInfo?.listPrice,
      price,
    ),
  );
  const images = extractImagesFromData(detail);
  const fallbackImages = images.length > 0 ? images : extractImagesFromHtml(html);
  const options = extractOptions(detail);
  const mergedDetailHtml = normalizeExtraHtml(extraHtml);

  if (!externalId && !title) return null;

  return {
    externalId: String(externalId || ''),
    title,
    brand,
    sellPrice: price,
    originalPrice: originalPrice || price,
    images: fallbackImages,
    options,
    sourceMarket: SOURCE_MARKET,
    sourceUrl: url,
    // 2026-05-19: 정보고시 — Gmarket/Auction PDP 표준 필드 (DOM 정밀 추출은 Phase 2).
    productNotices: {
      manufacturer: brand || 'G마켓',
      importer: 'G마켓 (주식회사 지마켓글로벌)',
      manufactureCountry: '상세설명 참조',
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'G마켓 고객센터 1566-5701',
    },
    ...(mergedDetailHtml ? { detailHtml: mergedDetailHtml, description: mergedDetailHtml } : {}),
  };
}

function parseList(html, url) {
  const products = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*href=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(html))) {
    const attrs = match[1];
    const body = match[2];
    const chunk = `${attrs}>${body}`;
    if (!looksLikeListCard(chunk)) continue;

    const href = extractAttribute(attrs, 'href') || '';
    const itemUrl = resolveUrl(url, href);
    const externalId = extractExternalId(chunk, chunk) || extractExternalId(itemUrl, chunk);
    const title = cleanText(
      readFirst(
        extractClassText(chunk, 'text__item'),
        extractClassText(chunk, 'itemname'),
        extractAttribute(attrs, 'title'),
        extractAttribute(attrs, 'aria-label'),
        stripTags(body),
      ),
    );
    const price = toNumber(
      readFirst(
        extractClassText(chunk, 'text__price'),
        extractClassText(chunk, 'price_real'),
        extractClassText(chunk, 'price'),
        extractPriceText(chunk),
      ),
    );
    const image = firstNonEmpty(extractAllImageUrls(chunk));

    if (!externalId && !title) continue;
    if (seen.has(String(externalId || itemUrl || title))) continue;
    seen.add(String(externalId || itemUrl || title));

    products.push({
      externalId: String(externalId || ''),
      title,
      brand: cleanText(readFirst(extractClassText(chunk, 'text__seller'), extractAttribute(attrs, 'data-brand'), '')),
      price,
      originalPrice: price,
      images: image ? [image] : [],
      options: [],
      sourceMarket: SOURCE_MARKET,
      sourceUrl: itemUrl || url,
    });
  }

  return products;
}

function extractInlineJson(html) {
  for (const re of SCRIPT_JSON_RES) {
    const match = html.match(re);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      // continue
    }
  }
  return null;
}

function pickDetailNode(rawData) {
  return rawData?.goods || rawData?.item || rawData?.data?.goods || rawData?.data?.item || rawData?.product || rawData || {};
}

function extractImagesFromData(detail) {
  const images = [];
  const candidates = Array.isArray(detail.images)
    ? detail.images
    : Array.isArray(detail.imageUrls)
      ? detail.imageUrls
      : Array.isArray(detail.goodsImages)
        ? detail.goodsImages
        : [];

  for (const image of candidates) {
    const url = typeof image === 'string'
      ? image
      : readFirst(image?.imageUrl, image?.url, image?.src, image?.originImageUrl);
    if (url) images.push(url);
  }

  return unique(images);
}

function extractOptions(detail) {
  const rawOptions = Array.isArray(detail.options)
    ? detail.options
    : Array.isArray(detail.optionList)
      ? detail.optionList
      : Array.isArray(detail.itemOptionList)
        ? detail.itemOptionList
        : [];

  return rawOptions
    .map((option) => {
      const name = cleanText(readFirst(option.name, option.optionName, option.valueName, option.optValue));
      if (!name) return null;
      const stockValue = readFirst(option.stockQty, option.stock, option.quantity, option.inventory);
      const stock = stockValue == null ? true : Number(stockValue) > 0 || stockValue === true;
      return {
        name,
        stock,
        externalOptionId: String(readFirst(option.optionId, option.optNo, option.id, name)),
      };
    })
    .filter(Boolean);
}

function extractTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return cleanText(match[1]).replace(/\s*[-|]\s*(?:Gmarket|Auction).*$/i, '').trim();
}

function extractImagesFromHtml(html) {
  return unique(extractAllImageUrls(html));
}

function extractAllImageUrls(html) {
  const urls = [];
  const imageRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imageRe.exec(html))) {
    urls.push(match[1]);
  }
  return urls;
}

function looksLikeListCard(chunk) {
  return (
    /image--itemcard/i.test(chunk) ||
    /image__item/i.test(chunk) ||
    /class=["'][^"']*itemname[^"']*["']/i.test(chunk) ||
    /data-goods-code|data-itemid|data-item-id|goodsCode=|itemNo=/i.test(chunk)
  );
}

function extractExternalId(primary, secondary) {
  const joined = `${primary || ''}\n${secondary || ''}`;
  const match = joined.match(
    /(?:goodsCode|goodsNo|itemId|itemid|itemNo|itemno|data-goods-code|data-item-id|data-itemid)=["']?([0-9A-Za-z]+)|\/item\/([0-9A-Za-z]+)(?:[/?#]|$)/i,
  );
  return match ? String(match[1] || match[2] || '') : '';
}

function extractAttribute(html, name) {
  const re = new RegExp(`\\b${name}=["']([^"']+)["']`, 'i');
  const match = html.match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractClassText(html, className) {
  const re = new RegExp(`<[^>]*class=["'][^"']*${escapeRegex(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(re);
  return match ? stripTags(match[1]) : '';
}

function extractPriceText(html) {
  const match = html.match(/([0-9][0-9,\s]{0,14})\s*원/);
  return match ? match[1] : '';
}

function resolveUrl(baseUrl, href) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getUrlPathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeExtraHtml(extraHtml) {
  return typeof extraHtml === 'string' && extraHtml.trim() ? extraHtml.trim() : '';
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanText(value) {
  return stripTags(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const digits = String(value || '').replace(/[^0-9.-]/g, '');
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function firstNonEmpty(values) {
  return values.find(Boolean) || '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
