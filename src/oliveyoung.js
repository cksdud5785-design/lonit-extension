// 목적: 올리브영 (m.oliveyoung.co.kr) collector — Phase 1 PoC.
//
// 정찰 결과 (2026-04-29 라이브 fetch + docs/overnight-20260428/09-new-sources-recon.md):
//   - robots.txt (m.oliveyoung.co.kr): ClaudeBot/Claude-SearchBot/GPTBot 화이트리스트 +
//     crawl-delay 5s. Allow `/m/goods` `/m/search` `/m/mtn` `/m/display` 등.
//     www.oliveyoung.co.kr 는 Cloudflare 로 모든 봇/UA 403 → 본 PoC 는 m. 서브도메인 only.
//   - 비로그인 OK — 정가 / 판매가 / 카테고리 / 브랜드 / 옵션(색상/사이즈) / 재고/품절 모두
//     SSR 시점에 Next.js streamed React Query state (self.__next_f) 로 노출됨.
//     멤버 가격 (CJ ONE) 은 로그인 전제 → Phase 2.
//   - PDP : GET https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A...
//     → HTML SSR + script-streamed JSON payload `queries[]` 안에 `data.data` Object.
//     주요 필드:
//       goodsNumber, goodsName, onlineBrandName, onlineBrandEngName, brand,
//       thumbnailImage[].url + .path, displayCategory.{upper,middle,lower,leaf}CategoryName,
//       standardCategory.{upper,middle,lower}CategoryName,
//       options[]: { optionNumber, optionName, salePrice, finalPrice, maxBenefitPrice,
//                    soldOutFlag, optionImage.url+path, colorChipImage.url+path },
//       salePrice, finalPrice, maxBenefitPrice, soldOutFlag, todayDeliveryFlag,
//       deliveryFreeFlag, leadTime, displayShapeCode, registeredDate, supplier,
//       maxBenefitPriceDto: { promotion: { discountAmount }, coupon: { discountAmount } }
//   - 검색 (`/m/mtn/search/result?query=...`): SSR 은 빈 shell (skeleton) — 결과는 client
//     fetch. PoC 단계에서는 단일 PDP URL 만 collect 지원, 검색은 빈 결과 반환 (Phase 2 에서
//     PC 사이트 또는 앱 API 도입 시 활성).
//
// rate-limit 정책:
//   - robots crawl-delay = 5s. 모든 fetch 직전 5s gate (lotteimall.js 패턴 mirror).
//   - DETAIL_DELAY = 5000ms, DETAIL_CONCURRENCY = 1.
//   - 분당 30req 제한 (=2s/req) 보다 훨씬 보수적 (12req/min) 으로 시작 → 운영 활성화 시
//     server-side AdaptiveRateLimiter 도입 후 가속 가능 (429 안 뜨면 자동).
//
// 화장품 카테고리 (Phase 1 fallback):
//   - displayCategory.upperCategoryName: '뷰티' / standardCategory.upperCategoryName: '기초화장품'
//     은 네이버 화장품 BC 코드 (50000xxx) 매핑이 별도 학습 필요. PoC 출력에는 categorySource
//     를 leafCategoryName 그대로 두고, isFallback.category=true 로 명시 → 서버 ingest 가
//     Phase 2 매핑 도입 전까지 자동 분류 보류.
//
// SourceFetcher 인터페이스 호환:
//   parseUrl / searchProducts / getDetail / getOptions / getLeadDays /
//   collect / cleanupOliveyoungTab.

// ─── 상수 ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://m.oliveyoung.co.kr';
const PDP_URL = `${BASE_URL}/m/goods/getGoodsDetail.do`;
// PDP 의 og:url 형식 (canonical).
const PDP_URL_CANONICAL = `${BASE_URL}/m/G.do`;

// robots.txt crawl-delay = 5s (ClaudeBot/Claude-SearchBot/GPTBot 모두 동일).
// lotteimall.js 패턴 mirror — fetch 직전 5s gate, 에러 retry 도 5s 이상.
const FETCH_DELAY_MS = 5000;
const DETAIL_CONCURRENCY = 1;
const STREAM_BATCH = 20;

// goodsNumber 형식: 'A' + 12자리 숫자 (정찰 확인 — 'A000000249650' 등).
// 향후 'B' / 'C' prefix 도 가능성 있어 [A-Z] 1자 + 12자리로 정의.
const GOODS_NO_RE = /^[A-Z]\d{12}$/;

// 비로그인 fetch 용 Mobile Safari UA (확장 service worker 에서 fetch 시 자동 부여되지만,
// 일관 lookup 용 명시. 정찰에서 본 UA 로 200 응답 검증 완료).
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── rate-limit gate ───────────────────────────────────────────────────────

let _lastFetchAt = 0;

/** robots.txt crawl-delay 5s 엄수 — 모든 oliveyoung fetch 직전 호출. */
async function rateLimitGate() {
  const now = Date.now();
  const gap = now - _lastFetchAt;
  if (gap < FETCH_DELAY_MS) {
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS - gap));
  }
  _lastFetchAt = Date.now();
}

/** 테스트 전용 — gate 상태 reset. production 코드에서 호출 금지. */
export function _resetRateLimitForTest() {
  _lastFetchAt = 0;
}

/**
 * fetch + 재시도 + 429/503 백오프. lotteimall.js 패턴 mirror.
 * @param {string} url
 * @param {{ retries?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>} HTML body
 */
async function fetchHtml(url, opts = {}) {
  const retries = opts?.retries ?? 2;
  const signal = opts?.signal;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new Error('aborted');
    await rateLimitGate();
    if (signal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'User-Agent': USER_AGENT,
        },
        credentials: 'omit', // Phase 1 비로그인. Phase 2 에서 멤버 가격 fetch 시 변경.
        signal,
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 503) && i < retries) {
          // gate 가 5s 보장 → backoff 강화 용 추가 대기 (10s, 15s).
          const extraWait = (5 + i * 5) * 1000;
          console.warn(`[올리브영] ${res.status} → 추가 ${extraWait / 1000}s backoff`);
          await new Promise((r) => setTimeout(r, extraWait));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      if (i >= retries) throw err;
      console.warn(`[올리브영] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
    }
  }
  throw new Error('fetchHtml: unreachable');
}

// ─── URL 파싱 ───────────────────────────────────────────────────────────────

// 2026-04-29 Codex (PR #856 MEDIUM-1) 반영: 와일드카드 .oliveyoung.co.kr 서픽스 허용은
// `receiver.ai.oliveyoung.co.kr`, `cf-images.oliveyoung.co.kr` 등 비스토어프론트
// 서브도메인까지 PDP URL 로 인식하는 위험. → 명시 화이트리스트만 허용.
// (m.oliveyoung.co.kr = 모바일 스토어, www.oliveyoung.co.kr = PC 스토어, apex
// = canonical/redirect)
const ALLOWED_HOSTS = new Set([
  'm.oliveyoung.co.kr',
  'www.oliveyoung.co.kr', // PoC 단계에선 fetch 안 하지만 URL 식별은 허용
  'oliveyoung.co.kr',
]);

/**
 * 입력 URL → { goodsNo? | keyword? }.
 *
 * 지원 패턴:
 *   - PDP : .../m/goods/getGoodsDetail.do?goodsNo=A...
 *   - 짧은 PDP: .../m/G.do?goodsNo=A...   (og:url canonical)
 *   - 검색: .../m/mtn/search/result?query=...
 *   - 일부 query alias: q / searchTerm
 *
 * @param {string} url
 * @returns {{ goodsNo?: string, keyword?: string }}
 */
export function parseUrl(url) {
  if (!url || typeof url !== 'string') return {};
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // 명시 화이트리스트만 허용 — receiver.ai.oliveyoung.co.kr / cf-images.oliveyoung.co.kr
    // 등 비스토어프론트 서브도메인은 PDP/검색 경로 매칭에서 제외 (Codex round1 MEDIUM).
    if (!ALLOWED_HOSTS.has(host)) return {};

    const path = u.pathname;
    // PDP 식별 — getGoodsDetail.do 정확 일치.
    if (
      path === '/m/goods/getGoodsDetail.do' ||
      path === '/store/goods/getGoodsDetail.do' ||
      path === '/m/G.do' ||
      path === '/G.do'
    ) {
      const goodsNo = u.searchParams.get('goodsNo');
      if (goodsNo && GOODS_NO_RE.test(goodsNo)) {
        return { goodsNo: String(goodsNo) };
      }
      return {};
    }
    // 검색 식별 — /m/mtn/search/result 또는 /m/search/...
    if (
      path === '/m/mtn/search/result' ||
      path === '/m/search/getSearchMain.do' ||
      path === '/store/search/getSearchMain.do'
    ) {
      const keyword =
        u.searchParams.get('query') ||
        u.searchParams.get('searchTerm') ||
        u.searchParams.get('q') ||
        '';
      if (keyword) return { keyword: keyword.trim() };
    }
    return {};
  } catch {
    return {};
  }
}

// ─── HTML → 구조화 페이로드 추출 (Next.js streamed React Query state) ────────

/**
 * 모든 `<script>self.__next_f.push([1,"..."]);</script>` 안의 escaped 페이로드를
 * 추출한 뒤 concatenate 한다. 이후 unescape 한 결과는 `c:[\"$\",..]` 형태의
 * dehydrated state JSON 부속 텍스트.
 *
 * @param {string} html
 * @returns {string} concatenated unescaped streamed payload (빈 문자열 if no streams)
 */
export function extractNextFStreamedPayload(html) {
  if (!html || typeof html !== 'string') return '';
  // self.__next_f.push([1,"<chunk>"])  — chunk 는 JSON 문자열 (이중 escape).
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  const chunks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const escaped = m[1];
    chunks.push(escaped);
  }
  if (chunks.length === 0) return '';
  // 각 chunk 는 JSON.stringify 된 문자열 부속이므로 JSON.parse('"' + chunk + '"')
  // 로 안전하게 unescape. 실패하면 raw chunk 사용.
  const decoded = chunks
    .map((c) => {
      try {
        return JSON.parse(`"${c}"`);
      } catch {
        return c;
      }
    })
    .join('');
  return decoded;
}

/**
 * unescaped streamed payload 안에서 goodsNumber 가 일치하는 product `data.data` Object 를
 * 균형 brace 스캔 으로 추출한다.
 *
 * 정찰: `"queries":[{"dehydratedAt":...,"state":{"data":{"data":{...PRODUCT...},"pagination":...}}` 형식.
 * 본 helper 는 `"queries"` 출현부 이후의 `"data":{"data":{` 시작 위치를 찾고, 그 직후
 * 의 균형된 brace block 을 잘라 JSON.parse 한다.
 *
 * @param {string} payload
 * @param {string} expectedGoodsNo  검증 용. 일치 안 하면 null.
 * @returns {object|null}
 */
export function extractGoodsDataFromPayload(payload, expectedGoodsNo) {
  if (!payload || typeof payload !== 'string') return null;
  // queries[] 안의 첫 `data`:{`data`:{ 패턴 위치 — 광고/추천 query 가 아닌 실 product
  // query 인지 확인하기 위해 `goodsNumber` 가 같은 block 안에 등장하는지 cross-check.
  const queriesIdx = payload.indexOf('queries');
  if (queriesIdx < 0) return null;

  // 모든 `"data":{"data":{` 위치를 찾고 각 위치별로 균형된 JSON 객체 추출 → goodsNumber
  // 일치 검증 후 반환.
  const re = /"data":\{"data":\{/g;
  re.lastIndex = queriesIdx;
  let match;
  while ((match = re.exec(payload)) !== null) {
    // brace 시작은 match.index + match[0].length - 1 (inner `{`) 한 단계 안.
    const innerStart = match.index + match[0].length - 1;
    const obj = sliceBalancedJsonObject(payload, innerStart);
    if (!obj) continue;
    let parsed;
    try {
      parsed = JSON.parse(obj);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.goodsNumber) {
      if (!expectedGoodsNo || parsed.goodsNumber === expectedGoodsNo) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * `s[start]` 위치의 `{` 부터 매칭되는 `}` 까지 substring 반환. 문자열 리터럴 안의
 * `{`/`}` 는 무시. escape (`\"`, `\\`) 도 처리.
 *
 * @param {string} s
 * @param {number} start
 * @returns {string|null}
 */
function sliceBalancedJsonObject(s, start) {
  if (s[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escNext = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escNext) {
        escNext = false;
      } else if (ch === '\\') {
        escNext = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ─── 정규화: thumbnail / 이미지 / 카테고리 ──────────────────────────────────

/**
 * 올리브영 이미지 URL 객체 ({ url, path }) → 절대 URL.
 * 정찰: `{ url: "https://image.oliveyoung.co.kr/cfimages/cf-goods/uploads/images/thumbnails",
 *          path: "10/0000/0024/A00000024965011ko.jpg?l=ko" }`
 * → `https://image.oliveyoung.co.kr/cfimages/cf-goods/uploads/images/thumbnails/10/0000/0024/A00000024965011ko.jpg?l=ko`
 */
function joinImageUrl(imgObj) {
  if (!imgObj || typeof imgObj !== 'object') return '';
  const url = String(imgObj.url || '').trim();
  const path = String(imgObj.path || '').trim();
  if (!url) return '';
  if (!path) return url;
  if (url.endsWith('/') && path.startsWith('/')) return url + path.slice(1);
  if (!url.endsWith('/') && !path.startsWith('/')) return `${url}/${path}`;
  return url + path;
}

/**
 * thumbnailImage[] → 절대 URL 배열 + dedup.
 * @param {Array} thumbnailImage
 * @returns {string[]}
 */
function extractImages(thumbnailImage) {
  if (!Array.isArray(thumbnailImage)) return [];
  const seen = new Set();
  const out = [];
  for (const img of thumbnailImage) {
    const u = joinImageUrl(img);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * displayCategory + standardCategory → leaf path string.
 * Phase 1 은 라벨만 emit (Phase 2 에서 네이버 BC 코드 매핑 도입).
 *
 * @param {object} data
 * @returns {string} e.g. "뷰티 > 스킨케어 > 크림" 또는 "기초화장품 > 스킨케어 > 크림"
 */
function extractCategorySource(data) {
  const dc = data?.displayCategory;
  if (dc) {
    const parts = [
      dc.upperCategoryName,
      dc.middleCategoryName,
      dc.lowerCategoryName,
      dc.leafCategoryName,
    ]
      .map((s) => (s ? String(s).trim() : ''))
      .filter(Boolean);
    // dedup 인접 중복 (e.g. lower=leaf 동일)
    const dedup = [];
    for (const p of parts) if (dedup[dedup.length - 1] !== p) dedup.push(p);
    if (dedup.length) return dedup.join(' > ');
  }
  const sc = data?.standardCategory;
  if (sc) {
    const parts = [
      sc.upperCategoryName,
      sc.middleCategoryName,
      sc.lowerCategoryName,
    ]
      .map((s) => (s ? String(s).trim() : ''))
      .filter(Boolean);
    if (parts.length) return parts.join(' > ');
  }
  return '';
}

// ─── 옵션 / 출고 ─────────────────────────────────────────────────────────────

/**
 * data.options[] → 표준 옵션 배열.
 *
 * 정찰: 단일 옵션 상품은 optionName=" " (space) 로 옴 → '기타' fallback.
 *
 * @param {object} data  parseDetail 결과의 raw goods data
 * @returns {Array<{ optionName: string, optionType: string, sku: string,
 *                   stock: number, isSoldout: boolean, priceDiff: number,
 *                   optionImage: string }>}
 */
// 2026-04-29 Codex (PR #856 HIGH-2 round2 후속): null emit 은 downstream
// /collect/receive 가 `Number(item.totalStock ?? 0)` 로 0 강제 + recalcTotal=10 cap
// 으로 fabricate. → musinsa fallback 컨벤션 (collect.ts:485 `capStock(remainQuantity ?? 99)`)
// 와 동일하게 in-stock 시 99 sentinel 사용. server-side MAX_STOCK=10 cap 이 자동
// clamp 하므로 실제 저장값은 10. isFallback.stock=true 로 PoC 신뢰도 함께 명시.
const STOCK_INSTOCK_FALLBACK = 99;

export function getOptions(data) {
  const options = Array.isArray(data?.options) ? data.options : [];
  if (options.length === 0) {
    // 옵션 없음 (이론상 발생 안 하지만 방어적). FREE 1개 fallback.
    const isSoldout = !!data?.soldOutFlag;
    return [
      {
        optionName: '기타',
        optionType: 'none',
        sku: String(data?.goodsNumber || ''),
        // soldout=0 (확실), in-stock=99 sentinel (server cap 10 자동 적용 — collect.ts:485
        // 의 musinsa fallback 컨벤션 mirror). Phase 1 정수 재고 미공개 신호는
        // isFallback.stock=true 로 별도 표시.
        stock: isSoldout ? 0 : STOCK_INSTOCK_FALLBACK,
        isSoldout,
        priceDiff: 0,
        optionImage: '',
      },
    ];
  }
  // 옵션 type 추론: colorChipImage 가 있으면 color, optionName 이 size 패턴이면 size.
  // 정찰 fixture (라카 틴트) 는 colorChipImage 보유 → color.
  const hasColorChip = options.some((o) => o?.colorChipImage);
  // baselinePrice = options[0].salePrice 또는 data.salePrice — priceDiff 산출용.
  const baselinePrice = Number(data?.salePrice) || Number(options[0]?.salePrice) || 0;
  return options.map((opt) => {
    const rawName = String(opt?.optionName ?? '').trim();
    const optionName = rawName || '기타';
    const optionType = hasColorChip
      ? 'color'
      : /\b(?:사이즈|size|\d+ml|\d+g|\d+\s*[xX]\s*\d)/i.test(optionName)
        ? 'size'
        : 'variant';
    const isSoldout = !!opt?.soldOutFlag;
    const optionPrice = Number(opt?.salePrice) || 0;
    const priceDiff = baselinePrice && optionPrice ? optionPrice - baselinePrice : 0;
    return {
      optionName,
      optionType,
      sku: String(opt?.standardCode ?? opt?.optionNumber ?? ''),
      // 올리브영 API 는 옵션별 stock 정수 미공개 (orderableMaximumQuantity 는 최대 주문량
      // != 재고). soldout=0 (확실), in-stock=99 (musinsa fallback 컨벤션, server
      // cap 10 자동 적용). Phase 1 정수 재고 미공개는 isFallback.stock=true 로 명시.
      stock: isSoldout ? 0 : STOCK_INSTOCK_FALLBACK,
      isSoldout,
      priceDiff,
      optionImage: joinImageUrl(opt?.optionImage) || joinImageUrl(opt?.colorChipImage) || '',
    };
  });
}

/**
 * 출고소요일.
 * 정찰: data.leadTime (정수) 가 정확한 신호. todayDeliveryFlag=true 면 1일.
 * leadTime 누락 시 화장품 평균 1일 fallback (isFallback.leadDays 표기).
 *
 * @param {object} data
 * @returns {{ leadDays: number, isFallback: boolean }}
 */
export function getLeadDays(data) {
  if (data?.todayDeliveryFlag) return { leadDays: 1, isFallback: false };
  const lead = Number(data?.leadTime);
  if (Number.isFinite(lead) && lead > 0) return { leadDays: lead, isFallback: false };
  return { leadDays: 1, isFallback: true };
}

// ─── 상세 ───────────────────────────────────────────────────────────────────

/**
 * PDP HTML → raw goods data (extractNextFStreamedPayload + extractGoodsDataFromPayload).
 *
 * @param {string} goodsNo
 * @param {string} html
 * @returns {object|null}
 */
export function parseDetail(goodsNo, html) {
  const payload = extractNextFStreamedPayload(html);
  if (!payload) return null;
  return extractGoodsDataFromPayload(payload, goodsNo);
}

/**
 * 상세 fetch + parse.
 *
 * @param {string} goodsNo
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object|null>}
 */
export async function getDetail(goodsNo, opts = {}) {
  if (!goodsNo) return null;
  if (!GOODS_NO_RE.test(goodsNo)) {
    console.warn(`[올리브영] goodsNo 형식 비정상: ${goodsNo}`);
    return null;
  }
  const url = `${PDP_URL}?goodsNo=${encodeURIComponent(goodsNo)}`;
  const html = await fetchHtml(url, { signal: opts?.signal });
  return parseDetail(goodsNo, html);
}

// ─── 검색 (Phase 1 미구현 — Phase 2 에서 PC/앱 API 도입) ───────────────────

/**
 * 검색.
 * Phase 1: m.oliveyoung.co.kr SSR 은 빈 shell 만 반환 → 빈 결과.
 * Phase 2: PC 사이트 (Cloudflare 우회 필요) 또는 모바일 앱 JSON API 도입.
 *
 * @param {string} _keyword
 * @returns {Promise<Array<{ goodsNo: string }>>}
 */
export async function searchProducts(_keyword) {
  // PoC 단계에서는 빈 결과 반환. 단일 PDP URL 입력 만 collect 활성.
  return [];
}

// ─── 정규화: server payload ────────────────────────────────────────────────

/**
 * raw goods data + options + lead → 서버 onBatch payload 형식 (lotteimall.js parity).
 *
 * Phase 1 은 카테고리 매핑 미도입 — categorySource 는 라벨만 emit.
 * isFallback.{category, stock, options, leadDays, benefitPrice, productNotices, search}
 * 로 PoC 단계 신뢰도 명시.
 *
 * @param {{ goodsNo: string }} item
 * @param {object|null} data
 * @param {Array} options
 * @param {{ leadDays: number, isFallback: boolean }} leadInfo
 * @returns {object|null}
 */
function toProductPayload(item, data, options, leadInfo) {
  if (!data) return null;
  const goodsNo = String(item.goodsNo || data.goodsNumber || '');
  const name = String(data.goodsName || '').trim();
  const brand =
    String(data.onlineBrandName || '').trim() ||
    String(data.shortName || '').trim() ||
    '';
  const brandEn = String(data.onlineBrandEngName || '').trim();
  const images = extractImages(data.thumbnailImage);
  const thumbnail = images[0] || '';
  const categorySource = extractCategorySource(data);

  // 가격 — top-level 우선 (대표 옵션 가격), 없으면 첫 옵션의 raw salePrice (절대 가격).
  // 2026-04-29 Codex (PR #856 MEDIUM-2) 반영: priceDiff 는 baseline 대비 delta 라
  // top-level 누락 시 절대 가격 fabricate 위험. options[].salePrice (raw) 로 교체.
  const salePrice =
    Number(data.salePrice) || Number(data?.options?.[0]?.salePrice) || 0;
  const finalPrice = Number(data.finalPrice) || salePrice;
  const maxBenefitPrice = Number(data.maxBenefitPrice) || finalPrice;

  // promotion / coupon 분해 — maxBenefitPriceDto 안에 있음.
  const promo = data?.maxBenefitPriceDto?.promotion;
  const coupon = data?.maxBenefitPriceDto?.coupon;
  const promotionDiscount = Number(promo?.discountAmount) || 0;
  const couponDiscount = Number(coupon?.discountAmount) || 0;
  // 2026-04-29 Codex (PR #856 HIGH-1) 반영: CLAUDE.md 컨벤션 `couponPrice = sell_price`
  // (쿠폰 적용 후 최종 결제가) 와 일치하도록 finalPrice (= 프로모션+쿠폰 모두 적용 후
  // 결제가) 를 사용. 기존 `salePrice - promotionDiscount` 는 쿠폰 적용 전 단계 가격
  // 이라 dashboard 의 "기타" 마켓 cost basis 산정에서 매입가 overstate 위험.
  // 프로모션 단계 가격은 benefitDetails 에 별도 보존.
  const couponPrice = finalPrice;
  const benefitDetails = {
    promotionDiscount: promotionDiscount || null,
    couponDiscount: couponDiscount || null,
    // promotion 적용 후 / coupon 적용 전 단계 가격 — Phase 2 marginCalculator 참조용.
    promotionApplied: promotionDiscount > 0 ? Math.max(0, salePrice - promotionDiscount) : null,
    finalPrice: finalPrice || null,
    maxBenefitPrice: maxBenefitPrice || null,
  };

  // 재고 / 품절 — soldOutFlag 우선. options 가 모두 soldout 이어도 동일 결과.
  // 2026-04-29 Codex (PR #856 HIGH-2 round2 후속): totalStock = options[].stock 합계.
  // getOptions 에서 in-stock=99 sentinel + soldout=0 emit → 합계가 자연스럽게 산출되며
  // server-side MAX_STOCK=10 cap (collect.ts:27) 이 자동 clamp. fabricate 위험 없음.
  const optionsAllSoldout = options.length > 0 && options.every((o) => o.isSoldout);
  const isSoldout = !!data.soldOutFlag || optionsAllSoldout;
  const totalStock = options.reduce((acc, o) => acc + Math.max(0, Number(o.stock) || 0), 0);

  // 배송: deliveryFreeFlag=false → paid (배송비 정수 별도 endpoint 필요 → Phase 2).
  const shippingType = data.deliveryFreeFlag ? 'free' : 'paid';
  // shippingFee 정수 미공개 — Phase 1 은 0 (free) / null (paid, unknown). lotteon 패턴.
  const shippingFee = data.deliveryFreeFlag ? 0 : null;

  // sourceLeadDays — fallback 일 때 null emit (lotteimall 패턴 mirror).
  const sourceLeadDays = leadInfo.isFallback ? null : Number(leadInfo.leadDays) || null;

  // PDP URL — m. 서브도메인 canonical.
  const sourceUrl = `${PDP_URL_CANONICAL}?goodsNo=${encodeURIComponent(goodsNo)}`;

  return {
    sourceMarket: 'oliveyoung',
    sourceId: goodsNo,
    sourceUrl,
    brand,
    originalTitle: name,
    originalPrice: salePrice,
    sellPrice: finalPrice,
    couponPrice,
    discount: Math.max(0, salePrice - finalPrice),
    categorySource,
    thumbnail,
    images,
    specs: {
      ...(brandEn ? { brandEn } : {}),
      ...(data.standardCategory?.lowerCategoryName
        ? { standardCategoryLeaf: data.standardCategory.lowerCategoryName }
        : {}),
      ...(data.brand ? { brandCode: String(data.brand) } : {}),
      ...(data.supplier ? { supplier: String(data.supplier) } : {}),
    },
    options,
    totalStock,
    isSoldout,
    // 2026-04-29 Codex (PR #856 MEDIUM-3) 반영: SSR 시점 fixture 에 reviewScore /
    // reviewCount 가 노출되지 않으므로 0 fabricate 금지. null emit 으로 "unknown"
    // 명시 (downstream UI/analytics 가 0 = "리뷰 없음" 으로 오인 방지). Phase 2 에서
    // gdaCnt / oneline_review API 통합 시 실값 emit.
    reviewScore: null,
    reviewCount: null,
    storeName: '올리브영',
    todayArrive: !!data.todayDeliveryFlag,
    benefitPrice: maxBenefitPrice && maxBenefitPrice !== finalPrice ? maxBenefitPrice : null,
    cardBenefitPrice: null, // Phase 2: CJ ONE 카드 즉시할인.
    benefitDetails,
    productNotices: null, // Phase 2: 정보 고시 PDP body 파싱.
    shippingType,
    shippingFee,
    sourceLeadDays,
    // PoC 신뢰도 명시 — server ingest 가 Phase 2 매핑 도입 전까지 fallback 로 기록.
    isFallback: {
      // 화장품 카테고리 — 네이버 BC 매핑 학습 후 false 전환 (Phase 2).
      category: true,
      // 옵션별 정수 재고 미노출 → soldOutFlag 만 신호.
      stock: true,
      // 옵션 자체는 fallback 이 아니지만 (실 데이터), stock 만 fallback.
      options: false,
      leadDays: !!leadInfo.isFallback,
      // 검색 — Phase 1 미구현.
      search: true,
      // 혜택가 / 카드즉시할인 — Phase 2.
      benefitPrice: false, // promotion+coupon 은 추출됨
      cardBenefitPrice: true,
      productNotices: true,
    },
  };
}

// ─── 메인 collect ────────────────────────────────────────────────────────────

/**
 * 수집 진입점. Phase 1: 단일 PDP URL → 1 상품 collect. 검색 URL → 빈 결과.
 *
 * @param {string} url           PDP URL 또는 검색 URL
 * @param {number} _limit        (현재 미사용 — 단일 PDP only)
 * @param {Function} onProgress  (progress, total, sent, message)
 * @param {{ onBatch?: (products: any[]) => Promise<void>, signal?: AbortSignal }} options
 * @returns {Promise<Array<object>>}
 */
export async function collect(url, _limit = 1, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);

  if (parsed.keyword && !parsed.goodsNo) {
    // Phase 1: 검색 미구현 → 빈 결과 + UX 메시지.
    onProgress(100, 0, 0, '올리브영 검색은 Phase 2 에서 활성화 예정 (단일 상품 URL 만 지원)');
    return [];
  }
  if (!parsed.goodsNo) {
    console.error('[BulkFlow 올리브영] URL 파싱 실패 또는 미지원 형식:', url);
    onProgress(100, 0, 0, '올리브영 URL 파싱 실패');
    return [];
  }

  onProgress(0, 1, 0, '올리브영 상세 조회중...');

  let data = null;
  try {
    data = await getDetail(parsed.goodsNo, { signal: options?.signal });
  } catch (e) {
    if (e?.message === 'aborted') return [];
    console.error(`[BulkFlow 올리브영] 상세 ${parsed.goodsNo} 실패:`, e.message);
    onProgress(100, 1, 0, '상세 조회 실패');
    return [];
  }

  if (!data) {
    onProgress(100, 1, 0, '상세 데이터 추출 실패');
    return [];
  }

  const opts = getOptions(data);
  const lead = getLeadDays(data);
  const product = toProductPayload({ goodsNo: parsed.goodsNo }, data, opts, lead);

  if (!product) {
    onProgress(100, 1, 0, 'product 정규화 실패');
    return [];
  }

  if (options?.onBatch) {
    try {
      await options.onBatch([product]);
    } catch (e) {
      console.error('[올리브영] 배치 전송 실패:', e.message);
    }
  }

  onProgress(100, 1, 1, '수집 완료');
  console.log(`[올리브영] 완료: ${parsed.goodsNo} (${product.originalTitle})`);
  return [product];
}

// ─── 임시 탭 정리 (Phase 2 대비 noop) ────────────────────────────────────────

/**
 * 비로그인 fetch 만 사용 → 정리할 리소스 없음. Phase 2 (멤버 가격 / 로그인 토큰) 활성화
 * 시 chrome.tabs.remove 등으로 확장.
 */
export function cleanupOliveyoungTab() {
  // noop
}

// 최소한의 진단 헬퍼 — STREAM_BATCH 등 상수가 의도대로 export 되지 않으나
// 외부 lookup 시 디버깅 가능.
export const __internals = {
  GOODS_NO_RE,
  FETCH_DELAY_MS,
  DETAIL_CONCURRENCY,
  STREAM_BATCH,
  USER_AGENT,
};
