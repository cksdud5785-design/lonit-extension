/**
 * 목적: FOLDERStyle (folderstyle.com) parser — windowCollector PoC.
 *
 * 사이트 특성:
 *   - 목록: li.fb__items__list 카드 반복
 *   - 상세: /shop/goodsView/{id}
 *   - 더망고 PDP 로직은 미구현이라 Lonit 이 자체 파싱
 *   - 가격 힌트: span.price[ge-data-original-price]
 *
 * Contract:
 *   parse(html, url, extraHtml) → Product[]
 *
 * Strategy:
 *   - service worker 환경 (DOMParser 없음) — regex 만 사용
 *   - PDP URL 이면 상세 1건, 아니면 목록 다건 파싱
 *   - Worksout parser 스타일을 따라 background-side pure parse 로 유지
 */

const SOURCE_MARKET = 'folderstyle';
const PDP_URL_RE = /\/shop\/goodsView\/([^/?#]+)(?:[/?#]|$)/i;
const LIST_ITEM_RE = /<li\b[^>]*class=["'][^"']*fb__items__list[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;

export const hostMatches = ['folderstyle.com'];

/**
 * @param {string} html
 * @param {string} url
 * @param {string|null} extraHtml
 * @returns {Promise<Array>}
 */
export async function parse(html, url, extraHtml) {
  const combinedHtml = mergeHtml(html, extraHtml);
  const detailMatch = String(url || '').match(PDP_URL_RE);

  if (detailMatch) {
    const detail = parseDetail(combinedHtml, url, detailMatch[1]);
    return detail ? [detail] : [];
  }

  return parseList(combinedHtml, url);
}

function parseDetail(html, url, productId) {
  const title = cleanTitle(
    readFirst(
      extractClassText(html, 'info__name'),
      extractClassText(html, 'goods-info__name'),
      extractMetaContent(html, 'property', 'og:title'),
      extractMetaContent(html, 'name', 'twitter:title'),
      extractDocumentTitle(html),
    ),
  );
  const brand = cleanText(
    readFirst(
      extractClassText(html, 'info__brand'),
      extractClassText(html, 'goods-info__brand'),
      extractAttributeFromTag(html, 'data-brand'),
      '',
    ),
  );

  const priceTag = extractPriceTag(html);
  const priceText = cleanText(readFirst(priceTag?.innerHtml, extractClassText(html, 'info__price__discount'), ''));
  const originalPrice = toNumber(
    readFirst(
      extractAttribute(priceTag?.attrs || '', 'ge-data-original-price'),
      extractClassText(html, 'info__price__cost'),
      extractLabelValue(html, ['정가', '소비자가', 'original price']),
      priceText,
    ),
  );
  const price = toNumber(priceText) || originalPrice;

  const images = unique(
    extractImagesFromSlider(html, url).concat(extractMetaImages(html, url)),
  );
  const options = extractOptions(html);
  const categorySource = extractBreadcrumb(html);
  const color = cleanText(extractLabelValue(html, ['색상', 'color']));
  const material = cleanText(extractLabelValue(html, ['소재', 'material']));
  const productCode = cleanText(
    readFirst(
      extractLabelValue(html, ['품번', '상품코드', 'product code', 'style code']),
      extractAttributeFromTag(html, 'data-product-code'),
      '',
    ),
  );
  const isSoldout = options.length > 0
    ? options.every((option) => !option.stock)
    : /soldout|sold out|품절/i.test(html);

  if (!productId && !title) return null;

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(productId || ''),
    productId: String(productId || ''),
    sourceUrl: url,
    originalTitle: title,
    titleKorean: title,
    brand,
    originalPrice: originalPrice || price,
    sellPrice: price,
    images,
    imageUrl: images[0] || '',
    options,
    categorySource,
    color,
    material,
    isSoldout,
    productCode,
  };
}

function parseList(html, url) {
  const products = [];
  const seen = new Set();
  let match;

  while ((match = LIST_ITEM_RE.exec(html))) {
    const chunk = match[0];
    const href = extractProductHref(chunk);
    const productUrl = resolveUrl(url, href);
    const productId = extractProductId(productUrl, chunk);
    const title = cleanText(readFirst(extractClassText(chunk, 'info__name'), extractAttribute(chunk, 'title'), ''));
    const brand = cleanText(extractClassText(chunk, 'info__brand'));
    const price = toNumber(
      readFirst(
        extractClassText(chunk, 'info__price__discount'),
        extractClassText(chunk, 'price'),
        '',
      ),
    );
    const originalPrice = toNumber(
      readFirst(
        extractClassText(chunk, 'info__price__cost'),
        extractAttribute(chunk, 'ge-data-original-price'),
        price,
      ),
    ) || price;
    const imageUrl = firstNonEmpty(extractAllImageUrls(chunk, productUrl || url));
    const dedupeKey = String(productId || productUrl || title);

    if (!title && !productId) continue;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    products.push({
      sourceMarket: SOURCE_MARKET,
      sourceId: String(productId || ''),
      productId: String(productId || ''),
      sourceUrl: productUrl || url,
      title,
      titleKorean: title,
      brand,
      price,
      originalPrice,
      sellPrice: price,
      images: imageUrl ? [imageUrl] : [],
      imageUrl: imageUrl || '',
      options: [],
      categorySource: '',
      color: '',
      material: '',
      isSoldout: /soldoutDim|soldout|sold out|품절/i.test(chunk),
      productCode: '',
    });
  }

  return products;
}

function extractPriceTag(html) {
  const re = /<span\b([^>]*)class=["'][^"']*\bprice\b[^"']*["']([^>]*)>([\s\S]*?)<\/span>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = `${match[1] || ''} ${match[2] || ''}`;
    return { attrs, innerHtml: match[3] || '' };
  }

  return null;
}

function extractOptions(html) {
  const options = [];
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;

  while ((selectMatch = selectRe.exec(html))) {
    const selectAttrs = selectMatch[1] || '';
    const selectBody = selectMatch[2] || '';
    const looksLikeOptionSelect = /option|size|select/i.test(selectAttrs) || /사이즈|옵션|품절/i.test(selectBody);
    if (!looksLikeOptionSelect) continue;

    const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRe.exec(selectBody))) {
      const attrs = optionMatch[1] || '';
      const rawText = cleanText(optionMatch[2] || '');
      const value = cleanText(extractAttribute(attrs, 'value'));
      const textParts = rawText.split('|').map((part) => cleanText(part)).filter(Boolean);
      const name = textParts[0] || rawText;
      if (!name || isPlaceholderOption(name, value)) continue;

      const soldoutText = `${rawText} ${attrs}`;
      options.push({
        name,
        stock: !/\bdisabled\b|sold\s*out|품절/i.test(soldoutText),
        externalOptionId: String(value || name),
      });
    }
  }

  return dedupeOptions(options);
}

function extractBreadcrumb(html) {
  const breadcrumbChunk = readFirst(
    extractClassChunk(html, 'breadcrumb'),
    extractClassChunk(html, 'location'),
    extractAriaChunk(html, 'breadcrumb'),
    '',
  );
  if (!breadcrumbChunk) return '';

  const parts = [
    ...extractTagTexts(breadcrumbChunk, 'a'),
    ...extractTagTexts(breadcrumbChunk, 'span'),
  ]
    .map(cleanText)
    .filter(Boolean);

  return unique(parts).join(' > ');
}

function extractProductHref(chunk) {
  const hrefRe = /href=["']([^"']+)["']/gi;
  let match;
  let fallback = '';

  while ((match = hrefRe.exec(chunk))) {
    const href = decodeEntities(match[1] || '');
    if (!fallback) fallback = href;
    if (PDP_URL_RE.test(href)) return href;
  }

  return fallback;
}

function extractProductId(url, html) {
  const directMatch = String(url || '').match(PDP_URL_RE);
  if (directMatch) return directMatch[1];

  const fallback = `${url || ''}\n${html || ''}`.match(
    /(?:data-product-id|data-goodsno|goodsNo|productId|goodsView\/)(?:=["']?)?([A-Za-z0-9_-]{4,})/i,
  );
  return fallback ? fallback[1] : '';
}

function extractMetaImages(html, baseUrl) {
  const images = [];
  const ogImage = extractMetaContent(html, 'property', 'og:image');
  if (ogImage) images.push(resolveUrl(baseUrl, ogImage));
  return images.filter(Boolean);
}

function extractImagesFromSlider(html, baseUrl) {
  const sliderChunk = readFirst(
    extractClassChunk(html, 'js__productImg__slider'),
    extractClassChunk(html, 'fb__goodsView'),
    '',
  );
  const preferred = extractAllImageUrls(sliderChunk, baseUrl).filter(isLikelyProductImage);
  if (preferred.length > 1) return preferred;
  return extractAllImageUrls(html, baseUrl).filter(isLikelyProductImage);
}

function extractAllImageUrls(html, baseUrl) {
  const urls = [];
  const imageRe = /<img\b[^>]*(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imageRe.exec(html))) {
    const resolved = resolveUrl(baseUrl, decodeEntities(match[1] || ''));
    if (resolved) urls.push(resolved);
  }

  return unique(urls);
}

function extractMetaContent(html, attrName, attrValue) {
  const re = new RegExp(
    `<meta\\b[^>]*\\b${escapeRegex(attrName)}=["']${escapeRegex(attrValue)}["'][^>]*\\bcontent=["']([^"']+)["'][^>]*>`,
    'i',
  );
  const match = html.match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractDocumentTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]) : '';
}

function extractAttribute(html, name) {
  const re = new RegExp(`\\b${escapeRegex(name)}=["']([^"']+)["']`, 'i');
  const match = String(html || '').match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractAttributeFromTag(html, attrName) {
  const re = new RegExp(`\\b${escapeRegex(attrName)}=["']([^"']+)["']`, 'i');
  const match = String(html || '').match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractClassText(html, className) {
  const re = new RegExp(
    `<[^>]*class=["'][^"']*${escapeRegex(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? stripTags(match[1]) : '';
}

function extractClassChunk(html, className) {
  const re = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class=["'][^"']*${escapeRegex(className)}[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? match[0] : '';
}

function extractAriaChunk(html, ariaLabel) {
  const re = new RegExp(
    `<([a-z0-9]+)\\b[^>]*aria-label=["']${escapeRegex(ariaLabel)}["'][^>]*>[\\s\\S]*?<\\/\\1>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? match[0] : '';
}

function extractTagTexts(html, tagName) {
  const re = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, 'gi');
  const results = [];
  let match;

  while ((match = re.exec(String(html || '')))) {
    const text = stripTags(match[1]);
    if (text) results.push(text);
  }

  return results;
}

function extractLabelValue(html, labels) {
  for (const label of labels) {
    const thRe = new RegExp(
      `<(?:th|dt)\\b[^>]*>\\s*${escapeRegex(label)}\\s*<\\/(?:th|dt)>\\s*<(?:td|dd)\\b[^>]*>([\\s\\S]*?)<\\/(?:td|dd)>`,
      'i',
    );
    const thMatch = String(html || '').match(thRe);
    if (thMatch) return stripTags(thMatch[1]);
  }
  return '';
}

function isPlaceholderOption(name, value) {
  const joined = `${name} ${value}`.trim();
  return (
    !joined ||
    value === '' ||
    /선택|choose|option/i.test(joined)
  );
}

function isLikelyProductImage(url) {
  return !/logo|icon|sprite|banner|favicon/i.test(url);
}

function mergeHtml(html, extraHtml) {
  return [html, normalizeExtraHtml(extraHtml)].filter(Boolean).join('\n');
}

function normalizeExtraHtml(extraHtml) {
  return typeof extraHtml === 'string' && extraHtml.trim() ? extraHtml.trim() : '';
}

function dedupeOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const key = `${option.externalOptionId}:${option.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanTitle(value) {
  return cleanText(value).replace(/\s*[-|]\s*FOLDER(?:STYLE)?(?:\.COM)?\s*$/i, '').trim();
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return stripTags(value || '');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
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

function resolveUrl(baseUrl, href) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
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
