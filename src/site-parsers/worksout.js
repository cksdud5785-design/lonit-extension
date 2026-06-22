/**
 * 목적: Worksout (worksout.co.kr) parser — windowCollector 패턴 PoC.
 *
 * DEPRECATED (2026-05-18):
 *   - 실 collector 는 apps/extension/src/worksout.js fetch path 로 이동.
 *   - 본 파일은 background.js windowCollector 회귀 방지 / 호환성 유지용으로만 보존.
 *   - 신규 기능은 여기에 추가하지 말 것.
 *
 * 사이트 특성:
 *   - Next.js SPA (React + SSR + hydration)
 *   - __NEXT_DATA__ <script> 에 dehydratedState.queries[0].state.data 로 product 데이터 완전 포함
 *   - PDP URL: /products/{numeric_id}
 *   - search URL: /products?mainCategoryId={id}&subcategoryIds={ids}
 *
 * 더망고 미커버 — Lonit 자체 구현 (정찰 결과 themango_analysis/14_worksout_recon.md 미작성, 본 코드 코멘트 참고).
 *
 * Contract (window-collector.js 와 일치):
 *   parse(html, url, extraHtml) → Product[]
 *
 * Strategy:
 *   - service worker 환경 (DOMParser 없음) — regex 로 __NEXT_DATA__ 추출 후 JSON.parse
 *   - PDP URL 매칭 시 detail parse (1 product 반환)
 *   - search URL 매칭 시 search parse (다중 product card 의 PDP URL + 최소 정보, 실 detail 은 별도 수집)
 *
 * Fixture: src/__tests__/__fixtures__/worksout/pdp_187258.html
 */

const SOURCE_MARKET = 'worksout';
const NEXT_DATA_RE = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const PDP_URL_RE = /\/products\/(\d+)(?:[/?#]|$)/;

/**
 * @param {string} html       - document.documentElement.outerHTML
 * @param {string} url        - 페이지 URL
 * @param {string|null} extraHtml - 미사용 (worksout 은 iframe 없음)
 * @returns {Promise<Array>}  - Lonit Product shape
 */
export async function parse(html, url, _extraHtml, plpItems) {
  const nextData = extractNextData(html);
  const detailMatch = url.match(PDP_URL_RE);
  if (detailMatch && nextData) {
    const detail = parseDetail(nextData, url, detailMatch[1]);
    if (detail) return [detail];
  }
  // PLP fallback — runner 가 추출한 plpItems 사용
  return parsePlp(plpItems);
}

function parsePlp(plpItems) {
  if (!Array.isArray(plpItems)) return [];
  return plpItems.map((item) => ({
    sourceMarket: SOURCE_MARKET,
    sourceId: String(item.sourceId),
    sourceUrl: item.url,
    originalTitle: item.title || '',
    brand: '',
    originalPrice: Number(item.price) || 0,
    sellPrice: Number(item.price) || 0,
    images: item.image ? [item.image] : [],
    options: [],
    categorySource: '',
    isSoldout: false,
    isShallow: true,
  }));
}

/** __NEXT_DATA__ <script> 내용을 추출해서 JSON.parse. 실패 시 null. */
function extractNextData(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** PDP — dehydratedState.queries[0].state.data 에서 1 product 추출. */
function parseDetail(nextData, url, productId) {
  const queries = nextData?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries) || queries.length === 0) return null;
  const data = queries[0]?.state?.data;
  if (!data) return null;

  // images: originalUrl 우선 (고해상도). productImageUrls 도 같은 URL 들이지만 type 메타데이터 없음.
  const images = Array.isArray(data.images) && data.images.length > 0
    ? data.images.map((img) => img.originalUrl).filter(Boolean)
    : (Array.isArray(data.productImageUrls) ? data.productImageUrls : []);

  // options: productSizes → { name, stock, externalOptionId }
  const options = Array.isArray(data.productSizes)
    ? data.productSizes.map((s) => ({
        name: s.sizeName,
        stock: !s.isSoldOut,
        externalOptionId: String(s.productSizeId),
      }))
    : [];

  const allSoldOut = options.length > 0 && options.every((o) => !o.stock);

  const categorySource = [data.category1Name, data.category2Name]
    .filter(Boolean)
    .join(' > ');

  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: String(productId),
    sourceUrl: url,
    originalTitle: data.productName || '',
    titleKorean: data.productKoreanName || '',
    brand: data.brandName || '',
    originalPrice: Number(data.initialPrice) || 0,
    sellPrice: Number(data.currentPrice) || Number(data.initialPrice) || 0,
    discountRate: Number(data.discountedRate) || 0,
    images,
    options,
    categorySource,
    color: data.productInfo?.colorKoreanName || data.productInfo?.color || '',
    material: data.productInfo?.material || '',
    isSoldout: allSoldOut,
    productCode: data.productCode || '',
  };
}

/**
 * Search — Worksout 의 search SSR JSON 은 별도 dehydrated query 키로 들어옴.
 * 현재 PoC 는 PDP 만 대상. search 는 후속 단계 (Phase 2 또는 운영 후 보강).
 */
function parseSearch(_nextData, _url) {
  return [];
}
