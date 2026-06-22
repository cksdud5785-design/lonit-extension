// 목적: 롯데아이몰 (lotteimall.com) collector — Phase 1 PoC.
//
// 정찰 결과 (docs/overnight-20260428/09-new-sources-recon.md + 2026-04-29 PoC):
//   - robots.txt: AI 봇 (ClaudeBot/GPTBot 등) 화이트리스트 + crawl-delay 5s.
//     `/$ /goods/ /main/ /multiEvent/ /search/` 만 Allow → 본 collector 는 이 4 path 만 사용.
//   - 비로그인 OK — 정가 / 판매가 / 카테고리 / 이미지 / 브랜드 모두 JSON-LD + HTML 에서 추출.
//     혜택가 (멤버십/카드) 는 Phase 2.
//   - 검색: GET /search/searchMain.lotte?headerQuery={kw} → 60 items / page (페이지네이션 추후).
//   - PDP : GET /goods/viewGoodsDetail.lotte?goods_no={id} → JSON-LD `application/ld+json` block.
//   - 옵션 (사이즈/색상): SSR DOM 에 노출되지 않으면 `사이즈 선택` 클릭 후 layer 에서 dynamic
//     fetch — Phase 1 에서는 옵션 0 개일 때 `[{ optionName: '기타', stock: 99 }]` fallback
//     (쿠팡 단일상품 fallback 패턴, PR #441 참조).
//
// 본 PoC 의 수집 범위 (Phase 1):
//   - 1 상품 PDP fetch → JSON-LD 파싱 → ProductDetail 정규화. 검증 가능.
//   - 검색→상세 batch 흐름 (스트리밍 onBatch) 도 wire 되어 있으나, 운영 활성화는
//     SOURCES 등록 + DB sourceMarket='lotteimall' 1 상품 검증 후.
//
// rate-limit 정책:
//   - robots crawl-delay 5s 이지만 동일 origin sequential fetch 는 brute force 가 아니므로
//     실측 분당 30req (1 req/2s) 로 시작 → 운영 시 429/403 발생 시 감속.
//   - DETAIL_DELAY = 250ms (롯데ON 200ms 와 비슷), DETAIL_CONCURRENCY = 2 (보수적).
//
// 롯데ON 인프라 재사용:
//   - fetchJson retry/429 패턴 동일.
//   - 카테고리 매핑 코드 체계는 다름 (롯데홈쇼핑 = 우리홈쇼핑 별도) — 추후 매핑 PR.

const PAGE_SIZE = 60;
const SEARCH_URL = 'https://www.lotteimall.com/search/searchMain.lotte';
const PDP_URL = 'https://www.lotteimall.com/goods/viewGoodsDetail.lotte';
const IMG_BASE = 'https://image2.lotteimall.com';
// robots.txt crawl-delay = 5s (~12 req/min). Codex round1 CRITICAL 지적 반영.
// AdaptiveRateLimiter 가속 정책 도입 전까지는 hard-coded 5000ms + concurrency 1
// 로 robots.txt 엄수. 운영 활성화 시점에 server-side AdaptiveRateLimiter 로 이관 후
// 5s 미만으로 가속 가능 (429 안 뜨면 자동 가속).
const DETAIL_DELAY = 5000;
const DETAIL_CONCURRENCY = 1;
// MAX_PAGES: robots crawl-delay 5s 기준 — 1page = 60 items + N detail fetches.
// PoC 단계는 페이지네이션 미지원 (SSR 1page 60 items 만 사용 — 2026-04-29 정찰 확인).
// Phase 2 에서 페이지네이션 + AdaptiveRateLimiter 가속 후 확장.
const MAX_PAGES = 1;

// ─── HTTP 헬퍼 ──────────────────────────────────────────────────────────────

// Codex round2 CRITICAL 반영: search 직후 PDP fetch 사이 0s gap 발생 가능.
// 모듈 단위 _lastFetchAt 으로 모든 fetch 간 최소 DETAIL_DELAY (5s) 강제 → 모든
// 호출 경로 (search → detail → 다음 detail) 에서 일관 적용. 에러 retry 도 5s 이상.
let _lastFetchAt = 0;

/** robots.txt crawl-delay 5s 엄수 — 모든 lotteimall fetch 직전 호출. */
async function rateLimitGate() {
  const now = Date.now();
  const gap = now - _lastFetchAt;
  if (gap < DETAIL_DELAY) {
    await new Promise(r => setTimeout(r, DETAIL_DELAY - gap));
  }
  _lastFetchAt = Date.now();
}

/** 테스트 전용 — gate 상태 reset. production 코드에서 호출 금지. */
export function _resetRateLimitForTest() {
  _lastFetchAt = 0;
}

/** fetch + 재시도 + 429 백오프 — 롯데ON 패턴 mirror + crawl-delay 5s 엄수. */
async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    await rateLimitGate(); // Codex round2 CRITICAL: 모든 호출 + retry 직전에 5s gate
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
        credentials: 'omit', // 비로그인 — Phase 1 은 cookie 미사용
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 503) && i < retries) {
          // Codex round2: 429/503 에서 추가 대기. gate 가 5s 보장하므로 추가 wait
          // 는 backoff 강화 용도 (10s, 15s).
          const extraWait = (5 + i * 5) * 1000;
          console.warn(`[롯데아이몰] ${res.status} → 추가 ${extraWait / 1000}s backoff`);
          await new Promise(r => setTimeout(r, extraWait));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      if (i >= retries) throw err;
      // Codex round2 CRITICAL: 에러 후 1s retry 가 crawl-delay 5s 위반.
      // gate 가 다음 iteration 시작에서 5s 보장 → 여기서는 추가 jitter 없음.
      console.warn(`[롯데아이몰] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
    }
  }
  throw new Error('fetchHtml: unreachable');
}

// ─── 파서 ───────────────────────────────────────────────────────────────────

/**
 * HTML 에서 JSON-LD `application/ld+json` Product 객체 추출.
 *
 * 정찰 결과 (goods_no=12901016):
 *   { "@graph": [{ "@type": "Product", name, category, image, brand: { name },
 *                  offers: { price, salePrice, priceCurrency, availability,
 *                           shippingDetails: { shippingRate: { value } } },
 *                  aggregateRating: { ratingValue, reviewCount },
 *                  hasPart: { name, text } }] }
 *
 * @param {string} html
 * @returns {object|null} JSON-LD Product 또는 null (파싱 실패 / 비-Product 페이지)
 */
// 2026-05-19 RCA: lotteimall PDP 가 JSON-LD 제공 안 함 (Playwright probe 로 확인).
// 진짜 source = inline script: `var goodsInfo = new Array(); goodsInfo[N] = {...};` 패턴.
// JS object 라 키 quote 없음 + single quote 문자열. JSON.parse 전에 변환 필요.
// master_goods_yn='Y' 가 마스터, 나머지가 옵션.
const GOODS_INFO_ENTRY_RE = /goodsInfo\[(\d+)\]\s*=\s*(\{[\s\S]*?\})\s*;/g;

function jsObjectToJsonString(s) {
  // 1) single → double quote (문자열 값). 2) 키 quote 추가 (식별자만, 숫자/문자열 키 보존).
  return s
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
}

export function extractGoodsInfo(html) {
  if (!html || typeof html !== 'string') return null;
  const entries = [];
  const re = new RegExp(GOODS_INFO_ENTRY_RE.source, 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const idx = Number(m[1]);
    try {
      const parsed = JSON.parse(jsObjectToJsonString(m[2]));
      entries[idx] = parsed;
    } catch {
      // skip 1 entry — 다음 entry 시도
    }
  }
  const filtered = entries.filter((e) => e && typeof e === 'object');
  return filtered.length > 0 ? filtered : null;
}

function extractOgImage(html) {
  const m = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function extractCategoryFromDom(html) {
  // .location 또는 [class*=breadcrumb i] 시작 태그 찾고, 다음 ~1200 chars 에서
  // <a>텍스트</a> 추출 후 "홈" 제거. nested DOM (div > a > div > a) 정확 매칭 위해
  // 단순 inner-tag close 매칭 (</div>) 은 fail — chunk 추출 후 a 텍스트만 collect.
  const m = html.match(/<[^>]*class=["'][^"']*(?:location|breadcrumb)[^"']*["'][^>]*>/i);
  if (!m) return '';
  const start = m.index + m[0].length;
  const chunk = html.slice(start, start + 1500);
  const anchorRe = /<a[^>]*>([\s\S]*?)<\/a>/g;
  const parts = [];
  let am;
  while ((am = anchorRe.exec(chunk)) !== null) {
    const text = am[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (text && text !== '홈' && !parts.includes(text)) parts.push(text);
    if (parts.length >= 5) break;
  }
  return parts.join(' > ');
}

export function parseDetailFromGoodsInfo(goodsNo, html) {
  const gi = extractGoodsInfo(html);
  if (!Array.isArray(gi) || gi.length === 0) return null;
  const master = gi.find((g) => g && g.master_goods_yn === 'Y') || gi[0];
  if (!master) return null;
  const ogImg = extractOgImage(html);
  const category = extractCategoryFromDom(html);
  const original = Number(master.sale_price) || 0;
  const sell = Number(master.final_sale_price) || original;
  const inStock = master.sale_stat_cd === '10' && Number(master.inv_qty) > 0;
  return {
    goodsNo: String(master.goods_no || goodsNo),
    name: String(master.goods_nm || '').trim(),
    brand: String(master.brand_nm || '').trim(),
    category,
    originalPrice: original,
    sellPrice: sell,
    currency: 'KRW',
    inStock,
    shippingFee: 0,
    images: ogImg ? [ogImg] : [],
    thumbnail: ogImg,
    reviewScore: 0,
    reviewCount: 0,
    __goodsInfo: gi,
  };
}

export function extractJsonLd(html) {
  if (!html || typeof html !== 'string') return null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      // 롯데아이몰 JSON-LD 는 trailing comma 있을 수 있음 (`{ "name": "" },}`).
      // JSON.parse 가 fail 하면 1 회 한해 trailing comma fix 시도.
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const fixed = raw
          .replace(/,\s*}/g, '}')
          .replace(/,\s*\]/g, ']');
        parsed = JSON.parse(fixed);
      }
      const graph = parsed['@graph'];
      const candidates = Array.isArray(graph) ? graph : [parsed];
      const product = candidates.find(x => x && x['@type'] === 'Product');
      if (product) return product;
    } catch (e) {
      // skip — 다음 ld+json block 시도
    }
  }
  return null;
}

/**
 * HTML 에서 카테고리 breadcrumb 추출 (실 카테고리 path).
 *
 * 정찰: `<nav class="breadcrumb">홈 > 유니섹스 캐주얼 > 티셔츠 > ...</nav>` 가 SSR
 * 마크업에는 없고, JSON-LD `category` 필드 (단일 leaf 텍스트 "솔리드/무지티셔츠") +
 * body innerText path 만 사용 가능. PoC 는 JSON-LD `category` 1 단계 활용.
 *
 * @param {object|null} jsonLd
 * @returns {string} 카테고리 leaf 텍스트 (e.g., "솔리드/무지티셔츠"). 없으면 ''.
 */
export function extractCategoryFromJsonLd(jsonLd) {
  if (!jsonLd) return '';
  const c = jsonLd.category;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map(x => String(x).trim()).filter(Boolean).join(' > ');
  return '';
}

/**
 * JSON-LD offers 에서 가격 정보 추출.
 *
 * @param {object} jsonLd
 * @returns {{ original: number, sell: number, currency: string, inStock: boolean, shippingFee: number }}
 */
export function extractPriceFromJsonLd(jsonLd) {
  const offers = jsonLd?.offers || {};
  const original = Number(offers.price) || 0;
  // salePrice 가 정의되어 있으면 sell = salePrice, 아니면 sell = price.
  const sell = Number(offers.salePrice) || original;
  const currency = String(offers.priceCurrency || 'KRW');
  const inStock = String(offers.availability || '').includes('InStock');
  const shippingFee = Number(offers?.shippingDetails?.shippingRate?.value) || 0;
  return { original, sell, currency, inStock, shippingFee };
}

/**
 * JSON-LD image 필드 → URL 배열 (1 개일 수 있음).
 * 이미지 정규화: image2.lotteimall.com 절대경로로 통일.
 *
 * @param {object} jsonLd
 * @returns {string[]}
 */
export function extractImagesFromJsonLd(jsonLd) {
  const raw = jsonLd?.image;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map(u => {
      const s = String(u).trim();
      if (!s) return '';
      if (s.startsWith('http')) return s;
      if (s.startsWith('//')) return `https:${s}`;
      if (s.startsWith('/')) return `${IMG_BASE}${s}`;
      return `${IMG_BASE}/${s}`;
    })
    .filter(Boolean);
}

/**
 * goods_no → image2 패턴 해부:
 *   `https://image2.lotteimall.com/goods/{lvl1}/{lvl2}/{lvl3}/{goodsNo}_1.jpg`
 *   여기서 lvl1/2/3 은 goodsNo 의 끝에서 6/4/2 자리 묶음 (PR-1 검증 필요).
 *
 * 본 helper 는 PDP HTML 에서 정확한 이미지 path 를 못 찾을 때만 사용.
 *
 * @param {string} goodsNo
 * @param {string} suffix - '1' | 'H' | 'ML' | 'L' (정찰: 12901016_1.jpg / _H.jpg / _ML.jpg / _L.jpg)
 * @returns {string}
 */
export function buildImageUrlFromGoodsNo(goodsNo, suffix = '1') {
  const id = String(goodsNo || '').replace(/\D/g, '');
  if (!id) return '';
  // 정찰: goods_no=12901016 → image path = goods/16/10/90/12901016_1.jpg
  // 패턴: 끝에서 2자리씩 3 단계 (16, 10, 90)
  if (id.length < 6) return `${IMG_BASE}/goods/${id}_${suffix}.jpg`;
  const a = id.slice(-2);
  const b = id.slice(-4, -2);
  const c = id.slice(-6, -4);
  return `${IMG_BASE}/goods/${a}/${b}/${c}/${id}_${suffix}.jpg`;
}

// ─── URL 파싱 ──────────────────────────────────────────────────────────────

/**
 * 검색 URL / PDP URL 파싱.
 *
 * 지원:
 *   - 검색: https://www.lotteimall.com/search/searchMain.lotte?headerQuery=... (또는 searchTerm=, 호환)
 *   - PDP : https://www.lotteimall.com/goods/viewGoodsDetail.lotte?goods_no=...
 *
 * @param {string} url
 * @returns {{ keyword?: string, goodsNo?: string }}
 */
/** Allowed lotteimall hosts — exact match (`endsWith('.lotteimall.com')` 는
 * `notlotteimall.com` lookalike 통과 위험, Codex round2 MEDIUM 지적). */
const ALLOWED_HOSTS = new Set([
  'www.lotteimall.com',
  'm.lotteimall.com',
  'lotteimall.com',
]);

/** Allowed PDP/search path prefixes — robots.txt Allow path 와 정확히 일치. */
const PDP_PATH_PREFIX = '/goods/viewGoodsDetail.lotte';
const SEARCH_PATH_PREFIX = '/search/searchMain.lotte';

function buildPdpUrl(goodsNo) {
  return `${PDP_URL}?goods_no=${encodeURIComponent(goodsNo)}`;
}

export function parseUrl(url) {
  if (!url || typeof url !== 'string') return {};
  try {
    const u = new URL(url);
    // Codex round2 MEDIUM 반영: host suffix 검사는 lookalike 도메인 통과 위험.
    // 정확한 화이트리스트 매칭 + .lotteimall.com 서브도메인은 전용 .endsWith 분기.
    const host = u.hostname.toLowerCase();
    const isAllowed = ALLOWED_HOSTS.has(host) || host.endsWith('.lotteimall.com');
    if (!isAllowed) return {};
    // 추가 안전망: lotteimall.com 의 정확한 suffix 만 허용 (e.g. lotteimall.co != lotteimall.com).
    if (!host.endsWith('lotteimall.com')) return {};

    const path = u.pathname;
    // Codex round3 MEDIUM 반영: startsWith prefix 는 `/goods/viewGoodsDetail.lotteevil`
    // 같은 suffix 변종 (lookalike path) 통과 위험. → 정확한 pathname 일치 + 부속
    // 로 trailing slash 한 가지만 허용. lotteimall 서버 측은 항상 정확한 lotte
    // 경로를 사용 (정찰 확인) 이므로 exact match 가 안전하면서 functional 동등.
    if (path === PDP_PATH_PREFIX || path === PDP_PATH_PREFIX + '/') {
      const goodsNo = u.searchParams.get('goods_no');
      // 8~12 자리 숫자만 허용 (정찰: 8자리 진짜 상품 vs 10자리 promotional banner).
      if (goodsNo && /^\d{6,12}$/.test(goodsNo)) return { type: 'pdp', goodsNo: String(goodsNo) };
      return {};
    }
    if (path === SEARCH_PATH_PREFIX || path === SEARCH_PATH_PREFIX + '/') {
      const keyword =
        u.searchParams.get('headerQuery') ||
        u.searchParams.get('searchTerm') ||
        u.searchParams.get('q') ||
        '';
      const slog = (u.searchParams.get('slog') || '').trim();
      if (keyword) {
        return {
          type: 'search',
          keyword: keyword.trim(),
          ...(slog ? { slog } : {}),
        };
      }
    }
    return {};
  } catch {
    return {};
  }
}

// ─── 검색 ──────────────────────────────────────────────────────────────────

/**
 * 검색 결과 페이지 HTML → 상품 ID 목록.
 *
 * 정찰 결과: 결과 컨테이너는 SSR Vue 템플릿 placeholder 로 시작하여 client 에서
 * 채워지지만, 데이터는 SSR 시점에 이미 inline HTML 로 노출됨 (`.goods_unit` 60개).
 * 각 .goods_unit 의 `data-goods-no` 속성에 진짜 goodsNo (8자리) 가 박혀 있음.
 *
 * NOTE: HTML href `goods_no=...` 는 `#none` 또는 promotional banner ID 라 신뢰 불가.
 * 반드시 `data-goods-no` 또는 image alt path 에서 추출해야 함.
 *
 * @param {string} html
 * @returns {Array<{ goodsNo: string, name: string, image: string }>}
 */
/**
 * HTML 에서 모든 `<div class="...goods_unit...">` block 의 시작 위치를 찾고, 다음
 * `goods_unit` 시작 (또는 EOF) 까지를 한 chunk 로 잘라낸다. 정확한 closing div
 * 매칭은 정규식으로 어렵지만, lotteimall 검색 결과는 `goods_unit` 들이 sibling 으로
 * 이어지는 평탄 구조라 chunk-between-starts 가 안전.
 *
 * @param {string} html
 * @returns {string[]} chunks
 */
function extractGoodsUnitChunks(html) {
  const re = /<div\s+[^>]*class=["'][^"']*\bgoods_unit\b[^"']*["'][^>]*>/gi;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    starts.push(m.index);
  }
  if (!starts.length) return [];
  const chunks = [];
  for (let i = 0; i < starts.length; i++) {
    const next = i + 1 < starts.length ? starts[i + 1] : html.length;
    chunks.push(html.slice(starts[i], next));
  }
  return chunks;
}

export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  const seen = new Set();

  // 검색 결과에서 실제 PDP 링크가 노출되면 href 우선 사용.
  const hrefRe = /<a[^>]*href=["']([^"']*viewGoodsDetail\.lotte\?[^"']*goods_no=\d{6,12}[^"']*)["'][^>]*>/gi;
  let hrefMatch;
  while ((hrefMatch = hrefRe.exec(html)) !== null) {
    const rawHref = hrefMatch[1].replace(/&amp;/g, '&').trim();
    if (!rawHref || rawHref.startsWith('#')) continue;
    try {
      const resolved = new URL(rawHref, SEARCH_URL).toString();
      const parsed = parseUrl(resolved);
      if (!parsed.goodsNo || seen.has(parsed.goodsNo)) continue;
      seen.add(parsed.goodsNo);
      items.push({ goodsNo: parsed.goodsNo, name: '', image: '', url: buildPdpUrl(parsed.goodsNo) });
    } catch {
      // ignore malformed href and continue to legacy parsing
    }
  }

  // Codex round2 MEDIUM 반영: 'class="zzim"' 만 의존하는 매칭은 추천 위젯이
  // 같은 마크업을 재사용하면 leak 발생. → `.goods_unit` block 단위로 chunk 후
  // 그 안의 `data-goods-no` 만 추출. zzim 마크업 미존재 variant 도 안전.
  const chunks = extractGoodsUnitChunks(html);
  for (const chunk of chunks) {
    const m = chunk.match(/data-goods-no=["'](\d+)["']/);
    if (!m) continue;
    const id = m[1];
    if (!id || seen.has(id)) continue;
    if (!/^\d{6,12}$/.test(id)) continue;
    seen.add(id);
    items.push({ goodsNo: id, name: '', image: '', url: buildPdpUrl(id) });
  }

  // Codex round2 LOW 응답 — chunks 0 일 때 (e.g. SSR 마크업 변경) 기존 zzim
  // 패턴 fallback. 운영 모니터링에서 chunks=0 + zzim 매칭=N 발생 시 마크업 변경
  // 시그널 → 패치 트리거.
  if (chunks.length === 0) {
    const re = /<a[^>]*\bdata-goods-no=["'](\d+)["'][^>]*\bclass=["'][^"']*\bzzim\b/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      if (!/^\d{6,12}$/.test(id)) continue;
      seen.add(id);
      items.push({ goodsNo: id, name: '', image: '', url: buildPdpUrl(id) });
    }
  }
  return items;
}

/**
 * 검색 API 호출 → goodsNo 목록 (페이지별 60개).
 *
 * 정찰: 페이지네이션 파라미터는 `pageNo` 이지만, lotteimall 의 클라이언트 페이지네이션은
 * AJAX 로 이루어지며 SSR 1페이지만 60개 반환. PoC 는 1페이지 60개로 한정 (검증 후 확장).
 *
 * @param {string} keyword
 * @param {number} _pageNo 1-based (현재 PoC: 1만 사용)
 * @returns {Promise<Array<{ goodsNo: string }>>}
 */
export async function searchProducts(keywordOrParams, _pageNo = 1) {
  const keyword =
    typeof keywordOrParams === 'string'
      ? keywordOrParams
      : keywordOrParams?.keyword || keywordOrParams?.searchTerm || '';
  const slog =
    typeof keywordOrParams === 'string'
      ? '00101_1'
      : keywordOrParams?.slog || '00101_1';
  if (!keyword) return [];
  const qs = new URLSearchParams({ headerQuery: keyword });
  if (slog) qs.set('slog', slog);
  const url = `${SEARCH_URL}?${qs}`;
  const html = await fetchHtml(url);
  return parseSearchResults(html);
}

// ─── 상세 ───────────────────────────────────────────────────────────────────

/**
 * PDP HTML → 정규화된 ProductDetail.
 *
 * @param {string} goodsNo
 * @param {string} html
 * @returns {{
 *   goodsNo: string,
 *   name: string,
 *   brand: string,
 *   category: string,
 *   originalPrice: number,
 *   sellPrice: number,
 *   currency: string,
 *   inStock: boolean,
 *   shippingFee: number,
 *   images: string[],
 *   thumbnail: string,
 *   reviewScore: number,
 *   reviewCount: number,
 * } | null}
 */
export function parseDetail(goodsNo, html) {
  // 2026-05-19: Primary = window.goodsInfo (실 source). JSON-LD legacy fallback.
  const fromGoodsInfo = parseDetailFromGoodsInfo(goodsNo, html);
  if (fromGoodsInfo) return fromGoodsInfo;
  const jsonLd = extractJsonLd(html);
  if (!jsonLd) return null;

  const price = extractPriceFromJsonLd(jsonLd);
  const images = extractImagesFromJsonLd(jsonLd);
  // image fallback (JSON-LD image 누락 / 빈 배열)
  if (images.length === 0) {
    const fallback = buildImageUrlFromGoodsNo(goodsNo, '1');
    if (fallback) images.push(fallback);
  }

  const rating = jsonLd.aggregateRating || {};
  const brand = (jsonLd.brand && jsonLd.brand.name) || '';
  const category = extractCategoryFromJsonLd(jsonLd);
  const name = String(jsonLd.name || '').trim();

  return {
    goodsNo: String(goodsNo),
    name,
    brand: String(brand).trim(),
    category,
    originalPrice: price.original,
    sellPrice: price.sell,
    currency: price.currency,
    inStock: price.inStock,
    shippingFee: price.shippingFee,
    images,
    thumbnail: images[0] || '',
    reviewScore: Number(rating.ratingValue) || 0,
    reviewCount: Number(rating.reviewCount) || 0,
  };
}

/**
 * 상세 fetch.
 * @param {string} goodsNo
 * @returns {Promise<object|null>}
 */
export async function getDetail(goodsNo) {
  if (!goodsNo) return null;
  const url = `${PDP_URL}?goods_no=${encodeURIComponent(goodsNo)}`;
  const html = await fetchHtml(url);
  return parseDetail(goodsNo, html);
}

/**
 * 옵션 정보 fetch — Phase 1: JSON-LD 만으로는 옵션 알 수 없음 → 단일 옵션 fallback.
 *
 * Codex round1 HIGH 지적 반영: stock/isSoldout 을 hardcoded "in-stock" 로 emit
 * 하면 downstream 이 sold-out 인 상품을 활성으로 잘못 처리할 위험. → JSON-LD
 * `availability` 결과를 받아 fallback 옵션의 stock/isSoldout 을 거기에 맞춤.
 *
 * Phase 2: PDP HTML 의 `사이즈 선택` layer + AJAX `getOptStock` 류 endpoint 연결.
 *
 * @param {string} _goodsNo
 * @param {{ inStock?: boolean }} hint - parseDetail 결과 inStock 을 전달 받아 fallback 가공
 * @returns {Promise<Array<{ optionName: string, stock: number, isSoldout: boolean, isFallback: boolean }>>}
 */
export async function getOptions(_goodsNo, hint) {
  // 2026-05-19: hint 에 __goodsInfo (parseDetailFromGoodsInfo 결과) 가 있으면 실 옵션 entries 사용.
  // master_goods_yn !== 'Y' 인 entries = 옵션. master 와 가격 차이 = priceDiff.
  const gi = hint && Array.isArray(hint.__goodsInfo) ? hint.__goodsInfo : null;
  if (gi && gi.length > 0) {
    const master = gi.find((g) => g && g.master_goods_yn === 'Y') || gi[0];
    const masterSell = Number(master.final_sale_price) || Number(master.sale_price) || 0;
    const opts = gi
      .filter((g) => g && g.master_goods_yn !== 'Y')
      .map((o) => {
        const sell = Number(o.final_sale_price) || Number(o.sale_price) || 0;
        const inv = Number(o.inv_qty) || 0;
        const active = o.sale_stat_cd === '10';
        return {
          optionName: String(o.goods_nm || o.goods_choc_desc || '').trim() || `옵션-${o.goods_no}`,
          sku: String(o.goods_no || ''),
          stock: active ? Math.min(inv, 99) : 0,
          isSoldout: !active || inv === 0,
          priceDiff: sell - masterSell,
          isFallback: false,
        };
      });
    if (opts.length > 0) return opts;
    // 옵션 entries 가 비어도 master 1건만 → 단일 옵션 fallback
    const masterInv = Number(master.inv_qty) || 0;
    const masterActive = master.sale_stat_cd === '10';
    return [{
      optionName: '기타',
      sku: String(master.goods_no || ''),
      stock: masterActive ? Math.min(masterInv, 99) : 0,
      isSoldout: !masterActive || masterInv === 0,
      priceDiff: 0,
      isFallback: false,
    }];
  }
  // legacy fallback (JSON-LD path 또는 hint 누락)
  const hintProvided = !!(hint && typeof hint.inStock === 'boolean');
  const inStock = hintProvided ? hint.inStock : false;
  return [
    {
      optionName: '기타',
      stock: inStock ? 1 : 0,
      isSoldout: !inStock,
      isFallback: true,
      isHintProvided: hintProvided,
    },
  ];
}

/**
 * 출고소요일 — JSON-LD 에 명시 없음, "도착 예정" 텍스트 파싱은 Phase 2.
 *
 * 정찰: PDP body 에 `05/07(목)까지 도착 예정` 형식. 백화점 평균 2-3일 추정.
 *
 * Codex round1 HIGH 지적 반영: hardcoded 2일을 그대로 sourceLeadDays 로 emit
 * 하면 downstream 이 정확한 ETA 로 오인. → null 반환 + isFallback flag 분리.
 *
 * @param {string} _goodsNo
 * @returns {Promise<{ leadDays: number, isFallback: boolean }>}
 */
export async function getLeadDays(_goodsNo) {
  // Phase 2: PDP body 에서 "M/D(요일)까지 도착 예정" 정규식 추출.
  return { leadDays: 2, isFallback: true };
}

// ─── ProductDetail → 정규화 (서버 ingest 형식) ────────────────────────────

/**
 * PDP detail + options + leadDays → 서버 onBatch payload 형식.
 *
 * @param {{ goodsNo: string }} item
 * @param {ReturnType<typeof parseDetail>} detail
 * @param {Array} options
 * @param {number} leadDays
 */
function toProductPayload(item, detail, options, leadInfo) {
  if (!detail) {
    return null;
  }
  // Codex round1 HIGH 반영: options 가 fallback 일 때 totalStock 신뢰도 표시.
  // optionsFallback=true 면 server 측에서 stock-based isSoldout 판정을 무시하고
  // detail.inStock (JSON-LD availability) 만 신뢰해야 함.
  const optionsFallback = options.every(o => o && o.isFallback);
  const totalStock = options.reduce((acc, o) => acc + (o.stock || 0), 0);
  // isSoldout: JSON-LD availability 우선 (가장 신뢰 가능한 신호). fallback 옵션의
  // 합계가 0 이라는 사실만으로 sold-out 단정 금지.
  const isSoldout = optionsFallback ? !detail.inStock : (!detail.inStock || totalStock === 0);

  // sourceLeadDays: fallback 일 때 null emit → downstream 이 default ETA 로 처리.
  // numeric 값을 그대로 emit 하면 "정확한 2일 ETA" 로 오인됨 (Codex HIGH).
  const lead = leadInfo && typeof leadInfo === 'object' ? leadInfo : { leadDays: 2, isFallback: true };
  const sourceLeadDays = lead.isFallback ? null : Number(lead.leadDays) || null;

  return {
    sourceMarket: 'lotteimall',
    sourceId: item.goodsNo,
    name: detail.name,
    brand: detail.brand,
    originalPrice: detail.originalPrice,
    sellPrice: detail.sellPrice,
    couponPrice: 0, // Phase 2: 카드즉시할인 통합
    discount: Math.max(0, detail.originalPrice - detail.sellPrice),
    categorySource: detail.category,
    thumbnail: detail.thumbnail,
    images: detail.images,
    specs: {},
    options,
    totalStock,
    isSoldout,
    reviewScore: detail.reviewScore,
    reviewCount: detail.reviewCount,
    storeName: '롯데홈쇼핑',
    todayArrive: false,
    benefitPrice: null,
    cardBenefitPrice: null,
    benefitDetails: null,
    // 2026-05-18: 정보고시 — 롯데아이몰 PDP 표준 필드.
    productNotices: {
      manufacturer: String(detail?.brand || '롯데홈쇼핑'),
      importer: '롯데홈쇼핑 (주식회사 우리홈쇼핑)',
      manufactureCountry: '상세설명 참조',
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: '롯데홈쇼핑 고객센터 1899-2500',
    },
    shippingType: detail.shippingFee > 0 ? 'paid' : 'free',
    shippingFee: detail.shippingFee,
    sourceLeadDays,
    // Codex round1 HIGH 반영: PoC 단계에서 어떤 부분이 fallback 인지 명시.
    // server ingest 가 본 flag 를 기록 → 운영 모니터링에서 fallback 비율 가시화.
    isFallback: {
      options: optionsFallback,
      leadDays: !!lead.isFallback,
      // Phase 2 에서 false 로 전환될 영역들
      benefitPrice: true,
      productNotices: true,
    },
  };
}

// ─── 공개 collect API ──────────────────────────────────────────────────────

/**
 * 검색→상세→스트리밍 전송. Phase 1: 1 페이지 (60 상품) 한도, 옵션은 단일 fallback.
 *
 * @param {string} url
 * @param {number} limit
 * @param {Function} onProgress (progress, total, sent, message)
 * @param {{ onBatch?: (products: any[]) => Promise<void> }} options
 */
export async function collect(url, limit = 60, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  let searchItems = [];

  if (parsed.goodsNo) {
    // 단일 PDP URL → 1 상품 collect
    searchItems = [{ goodsNo: parsed.goodsNo, url: buildPdpUrl(parsed.goodsNo) }];
  } else if (parsed.type === 'search' || parsed.keyword) {
    onProgress(0, 0, 0, '롯데아이몰 검색중...');
    let pageNo = 1;
    const seen = new Set();
    while (searchItems.length < limit && pageNo <= MAX_PAGES) {
      const items = await searchProducts(parsed, pageNo);
      if (!items.length) break;
      let newCount = 0;
      for (const it of items) {
        if (searchItems.length >= limit) break;
        if (seen.has(it.goodsNo)) continue;
        seen.add(it.goodsNo);
        searchItems.push(it);
        newCount++;
      }
      const progress = Math.min(20, Math.round((searchItems.length / limit) * 20));
      onProgress(progress, items.length, searchItems.length, `검색 ${searchItems.length}/${limit}`);
      if (newCount === 0 || items.length < PAGE_SIZE) break;
      pageNo++;
      // rateLimitGate() 가 search 직전에 5s 보장하므로 추가 sleep 불필요.
    }
  } else {
    console.error('[BulkFlow 롯데아이몰] URL 파싱 실패:', url);
    return [];
  }

  if (!searchItems.length) {
    onProgress(100, 0, 0, '검색 결과 없음');
    return [];
  }

  const STREAM_BATCH = 20;
  const allProducts = [];
  let totalSent = 0;

  for (let batchStart = 0; batchStart < searchItems.length; batchStart += STREAM_BATCH) {
    const batchItems = searchItems.slice(batchStart, batchStart + STREAM_BATCH);

    // 상세 조회 (concurrency 2)
    const detailMap = new Map();
    const optionMap = new Map();
    const leadMap = new Map();
    for (let i = 0; i < batchItems.length; i += DETAIL_CONCURRENCY) {
      const chunk = batchItems.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.allSettled(chunk.map(async (item) => {
        try {
          const detail = await getDetail(item.goodsNo);
          detailMap.set(item.goodsNo, detail);
          if (detail) {
            // getOptions 에 detail.inStock 전달 → fallback 옵션의 stock/isSoldout
            // 이 JSON-LD availability 와 일치 (Codex round1 HIGH 반영).
            const [opts, lead] = await Promise.all([
              // 2026-05-19: detail 에 __goodsInfo 가 있으면 getOptions 가 실 옵션 entries 추출.
              getOptions(item.goodsNo, { inStock: detail.inStock, __goodsInfo: detail.__goodsInfo })
                .catch(() => [{ optionName: '기타', stock: detail.inStock ? 1 : 0, isSoldout: !detail.inStock, isFallback: true }]),
              getLeadDays(item.goodsNo).catch(() => ({ leadDays: 2, isFallback: true })),
            ]);
            optionMap.set(item.goodsNo, opts);
            leadMap.set(item.goodsNo, lead);
          }
        } catch (e) {
          console.warn(`[롯데아이몰] ${item.goodsNo} 상세 실패:`, e.message);
        }
      }));
      // Codex round2 CRITICAL 후속: rateLimitGate() 가 fetchHtml 직전에 5s 보장
      // 하므로 chunk 사이 추가 sleep 불필요. (이중 sleep 시 throughput 절반).
    }

    const batchProducts = batchItems
      .map(item => toProductPayload(
        item,
        detailMap.get(item.goodsNo),
        optionMap.get(item.goodsNo) || [],
        leadMap.get(item.goodsNo) || { leadDays: 2, isFallback: true },
      ))
      .filter(Boolean);

    if (options.onBatch && batchProducts.length) {
      try {
        await options.onBatch(batchProducts);
        totalSent += batchProducts.length;
      } catch (e) {
        console.error(`[롯데아이몰] 배치 전송 실패:`, e.message);
      }
    }
    allProducts.push(...batchProducts);

    const progress = 20 + Math.round(((batchStart + batchItems.length) / searchItems.length) * 80);
    onProgress(progress, searchItems.length, totalSent || allProducts.length,
      `처리: ${allProducts.length}/${searchItems.length}`);
  }

  onProgress(100, allProducts.length, allProducts.length, '수집 완료');
  console.log(`[롯데아이몰] 완료: ${allProducts.length}개`);
  return allProducts;
}

// ─── 임시 탭 정리 (Phase 2 대비 noop) ────────────────────────────────────────
/**
 * 혜택가 / 회원가 조회 시 임시 탭 사용했다면 정리 — Phase 1 은 비로그인 fetch 만 → noop.
 */
export function cleanupLotteimallTab() {
  // Phase 2: chrome.tabs.remove 등.
}
