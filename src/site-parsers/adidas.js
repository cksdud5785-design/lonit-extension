/**
 * 목적: Adidas (adidas.co.kr / adidas.com) parser — windowCollector 패턴.
 *
 * 사이트 특성:
 *   - Next.js SPA, __NEXT_DATA__ <script> 안 dehydratedState.queries[0].state.data 에 product 정보 완전 포함
 *   - PDP URL: /{slug}/{MODEL_CODE}.html (예: /samba-og-신발/KJ8900.html, 6글자 영숫자 model code)
 *   - search URL: /men-shoes 등 카테고리 path
 *   - 더망고 site.js:4116-4174 와 동일 도메인 매칭 (adidas. 전체), 단 더망고는 5회 스크롤 후 outerHTML 전체 전송 — Lonit 는 __NEXT_DATA__ 정밀 파싱
 *
 * Fixture: src/__tests__/__fixtures__/adidas/pdp_KJ8900.html
 *
 * Contract: parse(html, url, extraHtml) → Product[]
 */

const SOURCE_MARKET = 'adidas';
const NEXT_DATA_RE = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const PDP_URL_RE = /\/([A-Z0-9]{6})\.html(?:[/?#]|$)/;

/**
 * @param {string} html
 * @param {string} url
 * @param {string|null} _extraHtml
 * @returns {Promise<Array>}
 */
export async function parse(html, url, _extraHtml, plpItems) {
  const nextData = extractNextData(html);
  const detailMatch = url.match(PDP_URL_RE);
  if (detailMatch && nextData) {
    const detail = parseDetail(nextData, url, detailMatch[1]);
    if (detail) return [detail];
  }
  return parsePlp(plpItems);
}

function parsePlp(plpItems) {
  if (!Array.isArray(plpItems)) return [];
  return plpItems.map((item) => ({
    sourceMarket: SOURCE_MARKET,
    sourceId: String(item.sourceId),
    sourceUrl: item.url,
    originalTitle: item.title || '',
    brand: 'adidas',
    originalPrice: Number(item.price) || 0,
    sellPrice: Number(item.price) || 0,
    images: item.image ? [item.image] : [],
    options: [],
    categorySource: '',
    isSoldout: false,
    isShallow: true,
  }));
}

function extractNextData(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function parseDetail(nextData, url, modelCode) {
  const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries) || queries.length === 0) return null;

  // /api/products/{id} queryKey 매칭 (Adidas Next.js 패턴)
  const productQuery = queries.find((q) =>
    Array.isArray(q?.queryKey) && q.queryKey[0]?.includes?.('/api/products/'),
  ) || queries[0];

  const data = productQuery?.state?.data;
  if (!data) return null;

  const pricing = data.pricing_information || {};
  const attr = data.attribute_list || {};
  const images = Array.isArray(data.view_list)
    ? data.view_list.map((v) => v.image_url).filter(Boolean)
    : [];

  // variation_list — size 만 (stock 정보 별도 API, 본 PoC 는 is_orderable 만 확인)
  const isOrderable = attr.is_orderable !== false;
  const options = Array.isArray(data.variation_list)
    ? data.variation_list.map((v) => ({
        name: String(v.size || ''),
        stock: isOrderable, // PoC 한계 — variant-level stock 은 별도 API
        externalOptionId: String(v.sku || ''),
        gtin: v.gtin || undefined,
      }))
    : [];

  const categorySource = Array.isArray(data.breadcrumb_list)
    ? data.breadcrumb_list.map((b) => b.text).filter(Boolean).join(' > ')
    : '';

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(data.id || modelCode),
    sourceUrl: url,
    originalTitle: data.name || '',
    brand: attr.brand || 'adidas',
    originalPrice: Number(pricing.standard_price) || 0,
    sellPrice: Number(pricing.sale_price || pricing.currentPrice || pricing.standard_price) || 0,
    discountRate: parseDiscountPct(pricing.discount_text),
    images,
    options,
    categorySource,
    color: attr.color || '',
    searchColor: attr.search_color || '',
    material: Array.isArray(attr.base_material) ? attr.base_material.join(', ') : '',
    productType: Array.isArray(attr.productType) ? attr.productType.join(', ') : '',
    gender: attr.gender || '',
    isSoldout: !isOrderable,
    productCode: data.base_model_number || '',
    modelNumber: data.model_number || '',
  };
}

/** "-30%" → 30 (positive int). 빈값/파싱실패 → 0. */
function parseDiscountPct(text) {
  if (!text || typeof text !== 'string') return 0;
  const m = text.match(/-?(\d+)%?/);
  return m ? Number(m[1]) : 0;
}
