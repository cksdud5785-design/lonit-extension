/**
 * 목적: Nike (nike.com/kr, nike.com 글로벌) parser — windowCollector 패턴.
 *
 * 사이트 특성:
 *   - 한국 PDP URL: /kr/t/{slug}/{STYLE-COLOR} (예: /kr/t/줌-보메로-5-남성-신발-U3pM9V3c/IM3486-002)
 *   - 데이터 source: <script type="application/ld+json"> 의 ProductGroup (Schema.org)
 *     - hasVariant[] 안 25개 변형 (Product) — size + price + availability + gtin
 *   - 더망고 site.js:2420 는 nike.com/kr 분기 없음. Lonit 자체 구현.
 *
 * Fixture: src/__tests__/__fixtures__/nike/pdp_IM3486-002.html
 *
 * Contract: parse(html, url, extraHtml) → Product[]
 */

const SOURCE_MARKET = 'nike';
const STOCK_INSTOCK_FALLBACK = 10;
const JSON_LD_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
const NEXT_DATA_RE = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
// PDP URL: /kr/t/{slug}/{STYLE-COLOR} (예: IM3486-002, 6+숫자+dash+숫자)
const PDP_URL_RE = /\/(?:kr\/)?(?:launch\/)?t\/[^/]+\/([A-Z0-9]{2,}-[0-9]+)(?:[/?#]|$)/;
const SIZE_FROM_ID_RE = /#size-([^/?#]+)/i;
const SIZE_IN_NAME_RE = /\bSize\s+(.+?)\s*$/i;

/**
 * @param {string} html
 * @param {string} url
 * @param {string|null} _extraHtml
 * @returns {Promise<Array>}
 */
export async function parse(html, url, _extraHtml, plpItems) {
  // 2026-05-19 RCA: 실 Nike PDP 는 JSON-LD 에 Product 만 있고 ProductGroup/hasVariant 없음.
  // 진짜 데이터는 __NEXT_DATA__ (Next.js hydration) — selectedProduct + productInfo + sizes.
  // Playwright 로 styleColor IO7843-002 페이지 직접 캡처해서 schema 확인.
  const detailMatch = url.match(PDP_URL_RE);
  if (detailMatch) {
    const nextData = extractNextData(html);
    if (nextData) {
      const detail = parseNextDataDetail(nextData, url);
      if (detail) return [detail];
    }
    // legacy ProductGroup hasVariant fallback (구 Nike layout 호환)
    const group = extractProductGroup(html);
    if (group) {
      const detail = parseDetail(group, url, detailMatch[1]);
      if (detail) return [detail];
    }
  }
  return parsePlp(plpItems);
}

function extractNextData(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function parseNextDataDetail(nextData, url) {
  const pp = nextData?.props?.pageProps;
  const sp = pp?.selectedProduct;
  if (!sp || typeof sp !== 'object') return null;

  const pi = sp.productInfo || {};
  const prices = sp.prices || {};
  const sizes = Array.isArray(sp.sizes) ? sp.sizes : [];
  const tax = sp.taxonomyLabels || {};

  const options = sizes.map((s) => {
    const isActive = s?.status === 'ACTIVE';
    return {
      optionName: String(s?.localizedLabel || s?.label || '').trim() || 'FREE',
      sku: String(s?.merchSkuId || s?.gtins?.[0]?.gtin || ''),
      stock: isActive ? STOCK_INSTOCK_FALLBACK : 0,
      isSoldout: !isActive,
      priceDiff: 0,
    };
  });

  const categoryParts = [tax['Gender']?.[0], tax['Sports']?.[0], tax['Product Type']?.[0]].filter(Boolean);
  const categorySource = categoryParts.join(' > ');

  const allImages = Array.isArray(pp.colorwayImages) ? pp.colorwayImages : [];
  const styleColor = sp.styleColor;
  const matched = allImages.filter((i) => i?.styleColor === styleColor);
  const imgs = (matched.length > 0 ? matched : allImages)
    .map((i) => i?.squarishImg || i?.portraitImg)
    .filter(Boolean);

  const country = Array.isArray(sp.manufacturingCountriesOfOrigin) && sp.manufacturingCountriesOfOrigin[0]
    ? String(sp.manufacturingCountriesOfOrigin[0])
    : '상세설명 참조';

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(sp.styleColor || ''),
    sourceUrl: url,
    originalTitle: String(pi.fullTitle || pi.title || ''),
    brand: String(Array.isArray(sp.brands) && sp.brands[0] ? sp.brands[0] : 'Nike'),
    originalPrice: Number(prices.initialPrice) || 0,
    sellPrice: Number(prices.currentPrice) || 0,
    images: imgs,
    options,
    categorySource,
    productNotices: {
      manufacturer: 'Nike Korea Ltd.',
      importer: 'Nike Korea Ltd.',
      manufactureCountry: country,
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'Nike 고객센터 080-022-0182',
    },
    isSoldout: options.length > 0 && options.every((o) => o.isSoldout),
  };
}

function parsePlp(plpItems) {
  if (!Array.isArray(plpItems)) return [];
  return plpItems.map((item) => ({
    sourceMarket: SOURCE_MARKET,
    sourceId: String(item.sourceId),
    sourceUrl: item.url,
    originalTitle: item.title || '',
    brand: 'Nike',
    originalPrice: Number(item.price) || 0,
    sellPrice: Number(item.price) || 0,
    images: item.image ? [item.image] : [],
    options: [],
    categorySource: '',
    isSoldout: false,
    isShallow: true,
  }));
}

/** 모든 JSON-LD script 를 순회해서 @type=ProductGroup 첫 entry 반환. */
function extractProductGroup(html) {
  const matches = [...html.matchAll(JSON_LD_RE)];
  for (const m of matches) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const candidate of collectJsonLdNodes(parsed)) {
      if (hasJsonLdType(candidate, 'ProductGroup') && Array.isArray(candidate?.hasVariant)) {
        return candidate;
      }
    }
  }
  return null;
}

function collectJsonLdNodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectJsonLdNodes);
  const nodes = [node];
  if (Array.isArray(node['@graph'])) {
    nodes.push(...node['@graph'].flatMap(collectJsonLdNodes));
  }
  return nodes;
}

function hasJsonLdType(node, expectedType) {
  const type = node?.['@type'];
  if (Array.isArray(type)) return type.includes(expectedType);
  return type === expectedType;
}

function parseDetail(group, url, styleColor) {
  const variants = Array.isArray(group.hasVariant) ? group.hasVariant : [];
  if (variants.length === 0) return null;

  // 모든 variant 의 image 합집합 (URL dedup)
  const imageSet = new Set();
  variants.forEach((variant) => {
    if (variant.image) imageSet.add(variant.image);
  });

  const basePrice = readOfferPrice(group.offers) || readOfferPrice(variants[0]?.offers);

  // RCA (2026-05-18):
  // - background.js 는 site parser 결과를 sendProducts() 로 그대로 전달한다.
  //   Nike parser 만 { name, externalOptionId, stock:boolean } 를 emit 해서 ingest 가
  //   기대하는 { optionName, sku, stock:number, isSoldout, priceDiff } 와 어긋났고,
  //   그 결과 운영 DB option_name / sku 공백이 재현될 수 있었다.
  // - 이 parser 는 ProductGroup.hasVariant 만 읽는다. alternativeProduct / relatedProduct
  //   같은 다른 JSON-LD entry 는 설령 존재해도 직접 소비하지 않으므로 27 vs 25 차이의
  //   1차 원인은 아니다. 현재 증상은 size 없는 placeholder hasVariant 2개가 섞였거나
  //   중복 ingest 가 있었을 때 설명된다. 여기서는 전자를 차단하기 위해 size 해석 실패
  //   variant 를 필터링한다.
  const options = variants
    .map((variant) => buildVariantOption(variant, basePrice))
    .filter(Boolean);

  const allOutOfStock = options.length > 0
    ? options.every((option) => option.isSoldout)
    : variants.every((variant) => !isInStockAvailability(variant?.offers?.availability));
  const color = variants[0]?.color || '';

  // categorySource — Nike 는 ProductGroup 의 별도 breadcrumb 없음. URL slug 사용.
  const categorySource = extractCategoryFromUrl(url);

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(styleColor),
    productGroupId: String(group.productGroupID || ''),
    sourceUrl: url,
    originalTitle: group.name || variants[0]?.name || '',
    description: group.description || '',
    brand: group.brand?.name || 'Nike',
    originalPrice: basePrice || 0,
    sellPrice: basePrice || 0, // Nike JSON-LD 는 sale price 별도 표시 없음 — price 자체가 현재가
    discountRate: 0, // Nike 는 ld+json 에 discount 표시 없음
    images: [...imageSet],
    options,
    categorySource,
    color,
    gender: extractGender(group.audience?.suggestedGender),
    isSoldout: allOutOfStock,
    ratingValue: Number(group.aggregateRating?.ratingValue) || 0,
    reviewCount: Number(group.aggregateRating?.reviewCount) || 0,
    // 2026-05-18: 정보고시 (스마트스토어 17 필드 — Nike JSON-LD 에서 추출 가능한 만큼).
    productNotices: {
      productName: group.name || '',
      brand: group.brand?.name || 'Nike',
      color,
      material: '',           // Nike JSON-LD 미노출 — Phase 2 (PDP DOM scrape)
      manufactureCountry: '', // 동일
      manufacturer: 'Nike, Inc.',
      importer: 'Nike Korea Ltd.',
      certification: '',
      careInstructions: '',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'Nike Korea 080-022-0182',
      productGroupId: String(group.productGroupID || ''),
    },
  };
}

function buildVariantOption(variant, basePrice) {
  const optionName = resolveVariantSize(variant);
  if (!optionName) return null;

  const variantPrice = readOfferPrice(variant?.offers) || basePrice;
  const sku = resolveVariantSku(variant);
  const inStock = isInStockAvailability(variant?.offers?.availability);
  const gtin = readString(variant?.gtin);

  return {
    name: optionName,
    optionName,
    optionType: 'size',
    sku,
    stock: inStock ? STOCK_INSTOCK_FALLBACK : 0,
    isSoldout: !inStock,
    priceDiff: variantPrice - basePrice,
    externalOptionId: sku || readString(variant?.['@id']) || optionName,
    gtin: gtin || undefined,
    originalPrice: variantPrice,
  };
}

function resolveVariantSize(variant) {
  const directSize = readString(variant?.size);
  if (directSize) return directSize;

  const id = readString(variant?.['@id']);
  if (id) {
    const idMatch = id.match(SIZE_FROM_ID_RE);
    if (idMatch?.[1]) return decodeJsonLdFragment(idMatch[1]);
  }

  const name = readString(variant?.name);
  if (name) {
    const nameMatch = name.match(SIZE_IN_NAME_RE);
    if (nameMatch?.[1]) return nameMatch[1].trim();
  }

  return '';
}

function resolveVariantSku(variant) {
  return (
    readString(variant?.gtin) ||
    readString(variant?.sku) ||
    readString(variant?.identifier) ||
    ''
  );
}

function readOfferPrice(offers) {
  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const price = readOfferPrice(offer);
      if (price > 0) return price;
    }
    return 0;
  }
  return toNumber(offers?.price);
}

function isInStockAvailability(availability) {
  return /(^|[^a-z])in[_-]?stock([^a-z]|$)/i.test(String(availability || ''));
}

function readString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const str = readString(item);
      if (str) return str;
    }
    return '';
  }
  if (typeof value === 'object') {
    return (
      readString(value.value) ||
      readString(value['@value']) ||
      readString(value.id) ||
      readString(value.identifier) ||
      ''
    );
  }
  return '';
}

function decodeJsonLdFragment(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, '%20')).trim();
  } catch {
    return String(value).trim();
  }
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** URL `/kr/t/{slug}/{style-color}` 에서 slug 의 일부를 카테고리 힌트로 사용. */
function extractCategoryFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/kr\/t\/([^/]+)\//);
    if (!m) return '';
    const slug = decodeURIComponent(m[1]);
    // 예: "줌-보메로-5-남성-신발-U3pM9V3c" → "남성 > 신발"
    const tokens = slug.split('-');
    const hints = [];
    if (tokens.some((t) => /남성|men|mens/i.test(t))) hints.push('남성');
    else if (tokens.some((t) => /여성|women|womens/i.test(t))) hints.push('여성');
    else if (tokens.some((t) => /키즈|kids|youth/i.test(t))) hints.push('키즈');
    if (tokens.some((t) => /신발|shoes/i.test(t))) hints.push('신발');
    else if (tokens.some((t) => /의류|clothing|top|bottom/i.test(t))) hints.push('의류');
    return hints.join(' > ');
  } catch {
    return '';
  }
}

/** Schema.org gender URL → 한글. */
function extractGender(genderUrl) {
  if (!genderUrl) return '';
  if (/Male/.test(genderUrl)) return 'M';
  if (/Female/.test(genderUrl)) return 'F';
  if (/Unisex/.test(genderUrl)) return 'U';
  return '';
}
