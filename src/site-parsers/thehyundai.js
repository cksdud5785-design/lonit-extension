/**
 * TheHyundai (thehyundai.com / hi.thehyundai.com) parser for windowCollector.
 *
 * The reference 더망고 extension only collected canonical product links and
 * identified products by the `slitmCd` query parameter. This parser keeps that
 * proven link extraction path, then maps available PDP/list HTML into the
 * standard Lonit product shape without opening visible tabs.
 */

const SOURCE_MARKET = 'thehyundai';
const PDP_ID_RE = /(?:[?&]slitmCd=|\/product\/)([A-Z0-9]+)/i;

export async function parse(html, url, _extraHtml, plpItems) {
  const productId = extractProductId(url);
  if (productId) {
    const detail = parseDetail(html, url, productId);
    if (detail) return [detail];
  }

  const list = parseList(html, url);
  return list.length > 0 ? list : parsePlp(plpItems);
}

function parseDetail(html, url, productId) {
  const hydrated = extractHydratedDetail(html, productId);
  if (!hydrated && isErrorPage(html)) return null;

  const title = cleanTitle(readFirst(
    hydrated?.slitmNm,
    extractMetaContent(html, 'property', 'og:title'),
    extractMetaContent(html, 'name', 'twitter:title'),
    extractClassText(html, 'DetailTop_title'),
    extractClassText(html, 'prd-name'),
    extractClassText(html, 'product-name'),
    extractClassText(html, 'item-name'),
    extractDocumentTitle(html),
  ));
  const brand = cleanText(readFirst(
    hydrated?.brndInfo?.expsBrndNm,
    hydrated?.brndInfo?.operBrndNm,
    extractClassText(html, 'brand-name'),
    extractClassText(html, 'brand'),
    extractLabelValue(html, ['브랜드', 'brand']),
    '',
  ));
  const price = toNumber(readFirst(
    hydrated?.prcInfo?.dcPrc,
    hydrated?.prcInfo?.maxDcPrc,
    extractClassText(html, 'sale-price'),
    extractClassText(html, 'final-price'),
    extractClassText(html, 'price'),
    extractPriceText(html),
  ));
  const originalPrice = toNumber(readFirst(
    hydrated?.prcInfo?.sellPrc,
    hydrated?.prcInfo?.csmPrc,
    extractClassText(html, 'origin-price'),
    extractClassText(html, 'normal-price'),
    extractLabelValue(html, ['정가', '소비자가']),
    price,
  )) || price;
  const images = unique(extractHydratedImages(hydrated).concat(extractMetaImages(html, url), extractAllImageUrls(html, url)));
  const options = extractHydratedOptions(hydrated, price).concat(extractOptions(html));
  const detailHtml = buildDetailHtml(hydrated);
  const productNotices = buildProductNotices(hydrated, brand, title);

  if (!productId && !title) return null;

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(productId || ''),
    productId: String(productId || ''),
    sourceUrl: canonicalUrl(url, productId),
    originalTitle: title,
    titleKorean: title,
    brand,
    originalPrice,
    sellPrice: price || originalPrice,
    images,
    imageUrl: images[0] || '',
    options: dedupeOptions(options),
    categorySource: extractBreadcrumb(html),
    productCode: String(productId || ''),
    isSoldout: options.length > 0 ? options.every((option) => !option.stock) : hydrated?.itemSellGbcd !== '00' && /sold\s*out/i.test(html),
    productNotices,
    ...(detailHtml ? { detailHtml, description: stripTags(detailHtml) } : {}),
  };
}

function parseList(html, url) {
  const products = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*href=["'][^"']*(?:itemPtc\.thd|slitmCd=|\/product\/)[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(String(html || '')))) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const href = extractAttribute(attrs, 'href');
    const sourceUrl = resolveUrl(url, href);
    const sourceId = extractProductId(sourceUrl);
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);

    const title = cleanText(readFirst(
      extractAttribute(attrs, 'title'),
      extractAttribute(attrs, 'aria-label'),
      extractImageAlt(body),
      stripTags(body),
    ));
    const price = toNumber(extractPriceText(body));
    const image = firstNonEmpty(extractAllImageUrls(body, sourceUrl));

    products.push({
      sourceMarket: SOURCE_MARKET,
      sourceId,
      productId: sourceId,
      sourceUrl: canonicalUrl(sourceUrl, sourceId),
      originalTitle: title,
      titleKorean: title,
      brand: '',
      originalPrice: price,
      sellPrice: price,
      images: image ? [image] : [],
      imageUrl: image || '',
      options: [],
      categorySource: '',
      isSoldout: /품절|sold\s*out/i.test(body),
      productCode: sourceId,
      isShallow: true,
    });
  }

  return products;
}

function parsePlp(plpItems) {
  if (!Array.isArray(plpItems)) return [];
  return plpItems.map((item) => ({
    sourceMarket: SOURCE_MARKET,
    sourceId: String(item.sourceId || ''),
    productId: String(item.sourceId || ''),
    sourceUrl: item.url || '',
    originalTitle: item.title || '',
    titleKorean: item.title || '',
    brand: '',
    originalPrice: Number(item.price) || 0,
    sellPrice: Number(item.price) || 0,
    images: item.image ? [item.image] : [],
    imageUrl: item.image || '',
    options: [],
    categorySource: '',
    isSoldout: false,
    productCode: String(item.sourceId || ''),
    isShallow: true,
  }));
}

function extractOptions(html) {
  const options = [];
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let match;

  while ((match = optionRe.exec(String(html || '')))) {
    const attrs = match[1] || '';
    const name = cleanText(match[2] || '');
    const value = cleanText(extractAttribute(attrs, 'value'));
    if (!name || /선택|option/i.test(`${name} ${value}`)) continue;
    const isSoldout = /\bdisabled\b|품절|sold\s*out/i.test(`${attrs} ${name}`);
    options.push({
      name,
      optionName: name,
      stock: isSoldout ? 0 : 10,
      isSoldout,
      priceDiff: 0,
      externalOptionId: value || name,
    });
  }

  return dedupeOptions(options);
}

function extractHydratedDetail(html, productId) {
  const payload = extractNextStreamedPayload(html);
  if (!payload || !productId) return null;
  const marker = `"data":{"slitmCd":"${String(productId).replace(/"/g, '\\"')}"`;
  const markerIndex = payload.indexOf(marker);
  if (markerIndex < 0) return null;
  const objectStart = payload.indexOf('{', markerIndex);
  const objectJson = sliceBalancedJsonObject(payload, objectStart);
  if (!objectJson) return null;
  try {
    return JSON.parse(objectJson);
  } catch {
    return null;
  }
}

function extractNextStreamedPayload(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let match;
  while ((match = re.exec(String(html || '')))) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      chunks.push(match[1]);
    }
  }
  return chunks.join('');
}

function sliceBalancedJsonObject(source, start) {
  if (start < 0 || source[start] !== '{') return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function extractHydratedImages(detail) {
  if (!detail) return [];
  return unique((Array.isArray(detail.thumbInfoList) ? detail.thumbInfoList : [])
    .map((image) => buildThehyundaiImageUrl(image.orglImgNm))
    .filter(Boolean));
}

function buildThehyundaiImageUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.thehyundai.com/${String(path).replace(/^\/+/, '')}?RS=600x600&AR=0&SF=webp&AO=1`;
}

function extractHydratedOptions(detail, basePrice) {
  if (!detail || !Array.isArray(detail.uitmAttrList)) return [];
  return detail.uitmAttrList.map((option) => {
    const optionPrice = toNumber(option.uitmDcPrc || basePrice);
    const stock = option.uitmSellGbcd === '00' ? Math.max(0, Number(option.sellPossQty) || 0) : 0;
    return {
      name: cleanText(option.uitmTotNm || option.uitmNm),
      optionName: cleanText(option.uitmTotNm || option.uitmNm),
      optionType: cleanText(option.uitmAttrTypeNm || 'option'),
      stock,
      isSoldout: stock <= 0,
      priceDiff: optionPrice - (Number(basePrice) || optionPrice),
      sellPrice: optionPrice,
      externalOptionId: String(option.uitmCd || option.uitmSeq || option.uitmNm || ''),
    };
  }).filter((option) => option.optionName);
}

function buildDetailHtml(detail) {
  if (!detail) return '';
  const chunks = [];
  if (detail.itemTotAncm) chunks.push(detail.itemTotAncm);
  for (const item of Array.isArray(detail.htmlItstCntnList) ? detail.htmlItstCntnList : []) {
    if (item.htmlItstCntn && !/^\$[a-z0-9]+$/i.test(item.htmlItstCntn)) {
      chunks.push(item.htmlItstCntn);
    }
  }
  return chunks.join('\n');
}

function buildProductNotices(detail, brand, title) {
  const safeCert = Array.isArray(detail?.safeCertList) ? detail.safeCertList.find((item) => item.safeCertTxt) : null;
  const textInfo = (Array.isArray(detail?.textItstCntnList) ? detail.textItstCntnList : [])
    .map((item) => `${item.itstTitl || ''}: ${item.itstCntn || ''}`.trim())
    .filter((text) => text && !text.endsWith(':'));
  return {
    productName: title || detail?.slitmNm || '',
    brand,
    material: detail?.slitmDesc || 'See detail page',
    manufactureCountry: 'See detail page',
    manufacturer: brand || 'TheHyundai',
    importer: brand || 'TheHyundai',
    warranty: safeCert?.safeCertTxt || 'See detail page',
    asContact: detail?.brndInfo?.brndAsgnrTel || 'TheHyundai customer center',
    safetyCertification: safeCert?.safeCertTxt || '',
    noticeText: [detail?.itemNoti, detail?.itemRmrk, ...textInfo].filter(Boolean).join('\n'),
  };
}

function isErrorPage(html) {
  return /data-screen=["']error|NEXT_REDIRECT;replace;\/error|오류페이지템플릿|현재 확인할 수 없는 페이지/.test(String(html || ''));
}

function extractProductId(value) {
  const match = String(value || '').match(PDP_ID_RE);
  return match ? match[1] : '';
}

function canonicalUrl(url, productId) {
  if (!productId) return url || '';
  return `https://hi.thehyundai.com/product/${encodeURIComponent(productId)}`;
}

function extractMetaImages(html, baseUrl) {
  const image = extractMetaContent(html, 'property', 'og:image');
  return image ? [resolveUrl(baseUrl, image)] : [];
}

function extractAllImageUrls(html, baseUrl) {
  const urls = [];
  const imageRe = /<img\b[^>]*(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imageRe.exec(String(html || '')))) {
    const resolved = resolveUrl(baseUrl, decodeEntities(match[1] || ''));
    if (resolved && !/logo|icon|sprite|banner|favicon/i.test(resolved)) urls.push(resolved);
  }
  return unique(urls);
}

function extractImageAlt(html) {
  const match = String(html || '').match(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/i);
  return match ? decodeEntities(match[1]) : '';
}

function extractBreadcrumb(html) {
  const chunk = readFirst(
    extractClassChunk(html, 'breadcrumb'),
    extractClassChunk(html, 'location'),
    extractAriaChunk(html, 'breadcrumb'),
    '',
  );
  if (!chunk) return '';
  const parts = extractTagTexts(chunk, 'a').concat(extractTagTexts(chunk, 'span'))
    .map(cleanText)
    .filter(Boolean);
  return unique(parts).join(' > ');
}

function extractMetaContent(html, attrName, attrValue) {
  const re = new RegExp(
    `<meta\\b[^>]*\\b${escapeRegex(attrName)}=["']${escapeRegex(attrValue)}["'][^>]*\\bcontent=["']([^"']+)["'][^>]*>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractDocumentTitle(html) {
  const match = String(html || '').match(/<title>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]) : '';
}

function extractAttribute(html, name) {
  const re = new RegExp(`\\b${escapeRegex(name)}=["']([^"']+)["']`, 'i');
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
  const out = [];
  let match;
  while ((match = re.exec(String(html || '')))) {
    const text = stripTags(match[1]);
    if (text) out.push(text);
  }
  return out;
}

function extractLabelValue(html, labels) {
  for (const label of labels) {
    const re = new RegExp(
      `<(?:th|dt)\\b[^>]*>\\s*${escapeRegex(label)}\\s*<\\/(?:th|dt)>\\s*<(?:td|dd)\\b[^>]*>([\\s\\S]*?)<\\/(?:td|dd)>`,
      'i',
    );
    const match = String(html || '').match(re);
    if (match) return stripTags(match[1]);
  }
  return '';
}

function extractPriceText(html) {
  const match = String(html || '').match(/(?:₩|KRW)?\s*([0-9][0-9,\s]{2,})\s*원?/);
  return match ? match[1] : '';
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

function resolveUrl(baseUrl, href) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function cleanTitle(value) {
  return cleanText(value).replace(/\s*[-|]\s*(?:더현대|THE HYUNDAI).*$/i, '').trim();
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
