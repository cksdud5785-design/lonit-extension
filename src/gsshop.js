// 목적: GSshop (gsshop.com) collector — Phase 1 PoC.
//
// 정찰 결과 (docs/overnight-20260428/09-new-sources-recon.md Section 6 + 2026-04-29 PoC):
//   - robots.txt: User-agent: * Disallow / + 메이저 봇 (Googlebot, Yeti, GPTBot, ClaudeBot,
//     PerplexityBot 등) 화이트리스트. /basket/ /cust/ /member/ /mobile/ /mygsshop/ /ord/
//     /order/ /remove/cache/ 등 차단. crawl-delay 없음.
//   - 비로그인 fetch — 정가 / 판매가 / 카테고리 / 이미지 / 브랜드 / 옵션 모두 익명 접근 OK.
//     혜택가 (GS&POINT 적립 / 카드 즉시할인) 는 Phase 2.
//   - 검색: GET https://m.gsshop.com/search/searchSect.gs?tq={KW}
//     → SSR HTML 의 `var renderJsonPrdList = { prdList: [100 items], ... };` 로 100건/페이지.
//     각 item: { productCd, productName, brandNm, imageUrl, basePrice, salePrice,
//                discountRate, reviewCount, reviewAverage, isTempOut, freeDlvYn,
//                shippingCostType, prdClsCd, juklib, couponDesc, ... }
//   - PDP : GET https://m.gsshop.com/prd/prd.gs?prdid={PRDID} (10자리 numeric)
//     → SSR HTML 의 `var renderJson = { prd, pmo, prdrevw, prdInqry };` 단일 객체.
//     prd.prdNm / prd.brandNm / prd.brandCd / prd.ctgrInfo / prd.attrTypList (옵션) /
//     prd.dlvcAmt / prd.freeDlvFlg / prd.prdSaleSt / prd.mediaInfo.images /
//     prd.dlvInfo.dlvHeadrInfo.addInfo1 (도착예정 텍스트).
//     pmo.prc.salePrc / pmo.gsPrc / pmo.prc.dcAmt / pmo.aliaCardAccm.
//
// rate-limit 정책:
//   - GS WAF (Akamai 추정) 분당 임계 ≈40-70 req. 09 doc 권고 200-300ms.
//   - PoC 는 보수적 분당 30req (= 2000ms/req) 로 시작. AdaptiveRateLimiter (server side)
//     활성화 시 self-heal 가속. 운영 활성화 후 429/403 모니터링.
//   - 크롤-딜레이 없음 → 크게 안전 마진. 모바일 도메인 사용 (모바일 API 가 더 가벼움).
//
// 본 PoC 의 수집 범위 (Phase 1):
//   - 1 상품 PDP fetch → renderJson 파싱 → ProductDetail 정규화. 검증 가능.
//   - 검색→상세 batch 흐름 (스트리밍 onBatch) 도 wire. 운영 활성화는 SOURCES 등록 +
//     DB sourceMarket='gsshop' 1 상품 검증 후.
//
// 옵션 처리:
//   - prd.attrTypList: 배열. 각 entry { attrPrdCd, attrPrdRepCd, attrTypVal, stockFlg }.
//   - 단일 옵션 (생필품): attrTypList.length === 1, attrTypVal === '' 또는 '단품'.
//   - 다중 옵션 (의류): attrTypVal === '색상\\b사이즈' (\\b 는 backspace 0x08 char).
//   - stockFlg='N' = 재고 있음 (Not soldout). stockFlg='Y' = 품절.
//   - PoC: 옵션 정상 파싱 + 단일 옵션 fallback 자동 처리.
//
// SourceFetcher 인터페이스 호환:
//   parseUrl / searchProducts / getDetail / getOptions / getLeadDays / collect / cleanupGsshopTab.

// ─── 상수 ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://m.gsshop.com';
const SEARCH_URL = `${BASE_URL}/search/searchSect.gs`;
const PDP_URL = `${BASE_URL}/prd/prd.gs`;
const IMG_BASE = 'https://asset.m-gs.kr';
// 분당 30req = 2000ms/req. 09 doc 권고 200-300ms 보다 보수적 — Akamai WAF 는 burst
// 에 민감. AdaptiveRateLimiter 가 server side 에서 가속 자동 학습.
const FETCH_DELAY_MS = 2000;
const STREAM_BATCH = 20;
// 검색 결과는 한 페이지 100 items 고정 (실측). PoC 는 1 페이지만 사용.
const PER_PAGE = 100;
const MAX_PAGES = 1; // Phase 2 에서 페이지네이션 + 정렬별 패스 추가.

// 모바일 UA — m.gsshop.com 은 모바일 UA 일 때 SSR `renderJson` 을 inline 으로 노출.
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

// 판매상태 코드 — prdSaleSt 가 'Y' 일 때 판매중. 그 외 (대기/품절/단종) 은 isSoldout.
const SELL_STAT_AVAILABLE = 'Y';

// ─── rate-limiter ──────────────────────────────────────────────────────────

let _lastFetchAt = 0;
let _consecutiveBlocks = 0;

/** 마지막 fetch 후 FETCH_DELAY_MS 경과 보장. 차단 누적 시 백오프. */
async function throttle() {
  const now = Date.now();
  const baseDelay = FETCH_DELAY_MS * Math.pow(2, Math.min(_consecutiveBlocks, 3));
  const elapsed = now - _lastFetchAt;
  if (elapsed < baseDelay) {
    await new Promise((r) => setTimeout(r, baseDelay - elapsed));
  }
  _lastFetchAt = Date.now();
}

/** 테스트 전용 — gate 상태 reset. production 코드에서 호출 금지. */
export function _resetRateLimitForTest() {
  _lastFetchAt = 0;
  _consecutiveBlocks = 0;
}

/**
 * rate-limited fetch + HTML 파싱 + 재시도.
 * abcmart.js 패턴 mirror — signal end-to-end (in-flight request 까지 abort).
 *
 * @param {string} url
 * @param {{ retries?: number, signal?: AbortSignal }} opts
 * @returns {Promise<string>} HTML 본문
 */
async function fetchHtml(url, opts = {}) {
  const retries = opts?.retries ?? 2;
  const signal = opts?.signal;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new Error('aborted');
    await throttle();
    if (signal?.aborted) throw new Error('aborted');
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'User-Agent': USER_AGENT,
        },
        signal,
        credentials: 'omit', // 비로그인 — Phase 1 은 cookie 미사용
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 403) && i < retries) {
          _consecutiveBlocks++;
          const wait = 5000 * (i + 1);
          console.warn(`[GSshop] ${res.status} 차단 → ${wait / 1000}초 대기 후 재시도`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      _consecutiveBlocks = 0;
      return await res.text();
    } catch (err) {
      // 2026-04-29 Codex Round 1 (PR #858 MEDIUM): 실 fetch() abort 는 DOMException
      // {name: 'AbortError'} 로 reject. err.message='aborted' 만 체크하면 in-flight
      // 요청 abort 가 generic 실패로 retry → 즉시 종료 안 됨.
      if (err?.name === 'AbortError' || err?.message === 'aborted') throw err;
      if (i >= retries) throw err;
      console.warn(`[GSshop] fetch 실패 (${i + 1}/${retries + 1}):`, err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('fetchHtml: unreachable');
}

// ─── HTML → JSON 추출 헬퍼 ──────────────────────────────────────────────────

/**
 * SSR HTML 에 inline 으로 박힌 `var {varName} = { ... };` 객체 추출.
 *
 * GSshop 은 mustache/EJS 템플릿이 server-side 에서 dump 한 JS literal 을 파싱한다.
 * 정규식으로 `{...}` 블록 찾기 어려운 (nested) 패턴이라 brace-balance 알고리즘 사용.
 * 문자열 리터럴 내부의 `{` `}` 는 무시 (escape sequence + quote tracking).
 *
 * @param {string} html
 * @param {string} varName  e.g., 'renderJson' (PDP) | 'renderJsonPrdList' (검색)
 * @returns {object|null} 파싱된 객체 또는 null
 */
export function extractInlineJson(html, varName) {
  if (!html || typeof html !== 'string' || !varName) return null;
  const marker = `var ${varName} = `;
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let stringChar = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === stringChar) { inString = false; }
      continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const json = html.substring(start, i + 1);
        try {
          return JSON.parse(json);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

// ─── URL 파싱 ──────────────────────────────────────────────────────────────

/**
 * Allowed gsshop hosts — exact match 만 허용. wildcard subdomain 차단.
 *
 * 2026-04-29 Codex Round 1 (PR #858 MEDIUM): `host.endsWith('.gsshop.com')`
 * 는 `evil.gsshop.com` lookalike 통과 위험. 정찰 evidence 는 m./www./gsshop.com
 * 3 host 만이라 화이트리스트 strict.
 */
const ALLOWED_HOSTS = new Set([
  'm.gsshop.com',
  'www.gsshop.com',
  'gsshop.com',
]);

/**
 * 검색 URL / PDP URL 파싱.
 *
 * 지원:
 *   - 검색: https://m.gsshop.com/search/searchSect.gs?tq={KW}
 *   - 검색: https://www.gsshop.com/search/searchSect.gs?tq={KW} (자동 모바일 redirect)
 *   - PDP : https://m.gsshop.com/prd/prd.gs?prdid={PRDID}
 *   - PDP : https://www.gsshop.com/prd/prd.gs?prdid={PRDID}
 *   - PDP : https://m.gsshop.com/prd/prdDesc.gs?prdid={PRDID} (description page)
 *
 * @param {string} url
 * @returns {{ keyword?: string, prdid?: string }}
 */
export function parseUrl(url) {
  if (!url || typeof url !== 'string') return {};
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // 2026-04-29 Codex Round 1 (PR #858 MEDIUM): exact match — wildcard
    // subdomain (any.gsshop.com) 통과 차단.
    if (!ALLOWED_HOSTS.has(host)) return {};

    const path = u.pathname;
    // PDP path: /prd/prd.gs 또는 /prd/prdDesc.gs (둘 다 prdid 쿼리)
    if (path === '/prd/prd.gs' || path === '/prd/prdDesc.gs') {
      const prdid = u.searchParams.get('prdid');
      // 2026-04-29 Codex Round 1 (PR #858 MEDIUM): 정찰 evidence 는 10자리만 (1093844665, 1116221503, etc).
      // 8-12 자리 wildcard 는 promotional banner ID 등 lookalike 통과 위험.
      // GSshop 신상품 ID 가 11자리로 늘어날 가능성 대비해 10-11 자리 허용 (보수적 확장).
      if (prdid && /^\d{10,11}$/.test(prdid)) return { prdid: String(prdid) };
      return {};
    }
    // 검색 path: 다중 (사이트 redesign 호환).
    //   /search/searchSect.gs (m.gsshop.com 모바일 legacy)
    //   /search/searchMain.gs (legacy 데스크탑)
    //   /shop/search/main.gs (2026-05 현행 데스크탑 — 사용자 신고 path)
    // 모두 tq 쿼리 (또는 fallback keyword/q).
    if (
      path === '/search/searchSect.gs' ||
      path === '/search/searchMain.gs' ||
      path === '/shop/search/main.gs'
    ) {
      const keyword =
        u.searchParams.get('tq') ||
        u.searchParams.get('keyword') ||
        u.searchParams.get('q') ||
        '';
      if (keyword) return { keyword: keyword.trim() };
    }
    return {};
  } catch {
    return {};
  }
}

// ─── 검색 ──────────────────────────────────────────────────────────────────

/**
 * 검색 결과 1페이지 fetch + parse.
 *
 * GSshop 모바일 검색은 SSR HTML 에 `var renderJsonPrdList = { prdList: [...100], ... };`
 * 으로 100 items 를 inline 으로 dump. 별도 AJAX 호출 불필요.
 *
 * 2026-04-29 Codex Round 1 (PR #858 HIGH): GSshop 검색 응답에 명시적 `totalCount`
 * 필드가 없는데도 `{ items, totalCount: items.length }` 로 emit 하면 caller 가 그것을
 * "전체 검색 결과 수" 로 오인. 정직하게 items 만 반환하고 caller 가 length 직접 계산.
 *
 * Phase 2 에서 페이지네이션 추가 시 별도 endpoint (totalCount 진짜 노출하는 path) 검토.
 *
 * @param {{ keyword: string, signal?: AbortSignal }} params
 * @returns {Promise<{ items: Array<any> }>}
 */
export async function searchProducts(params) {
  const keyword = params?.keyword || '';
  if (!keyword) return { items: [] };
  const qs = new URLSearchParams({ tq: keyword });
  const url = `${SEARCH_URL}?${qs}`;
  const html = await fetchHtml(url, { signal: params?.signal });
  const items = parseSearchResults(html);
  return { items };
}

/**
 * 검색 결과 HTML → prdList 추출 (테스트용 헬퍼 — fetch 분리).
 * @param {string} html
 * @returns {Array<any>}
 */
export function parseSearchResults(html) {
  const data = extractInlineJson(html, 'renderJsonPrdList');
  return Array.isArray(data?.prdList) ? data.prdList : [];
}

// ─── 상세 ───────────────────────────────────────────────────────────────────

/**
 * 상품 상세 정보 fetch — `/prd/prd.gs` HTML 의 `var renderJson` 추출.
 *
 * @param {string} prdid
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} renderJson 객체 ({ prd, pmo, prdrevw, prdInqry, ... })
 */
export async function getDetail(prdid, opts = {}) {
  if (!prdid) throw new Error('prdid 필수');
  const url = `${PDP_URL}?prdid=${encodeURIComponent(prdid)}`;
  const html = await fetchHtml(url, { signal: opts?.signal });
  const data = extractInlineJson(html, 'renderJson');
  if (!data || !data.prd) {
    throw new Error('renderJson.prd 누락 — PDP 응답 구조 변경 가능');
  }
  return data;
}

/**
 * 상품 옵션 추출 — renderJson.prd.attrTypList 정규화.
 *
 * GSshop 옵션 형식:
 *   - 단일 (생필품/식품): [{ attrTypVal: '', stockFlg: 'N' }] — attrTypVal 비어있음
 *   - 단일 (단품 표기): [{ attrTypVal: '단품', stockFlg: 'N' }]
 *   - 다중 (의류): [{ attrTypVal: '라이트블루(LBL)\\b2(55)', stockFlg: 'N' }, ...]
 *     → \\b (0x08 backspace) 가 axis 구분자. 색상 → 사이즈 순.
 *
 * stockFlg='N' = 재고 있음 (Not soldout — GSshop 의 NOT-out 의미).
 * stockFlg='Y' = 품절.
 *
 * @param {any} detail   getDetail 결과
 * @returns {Array<{ optionName: string, optionType: string, sku: string, stock: number, isSoldout: boolean, priceDiff: number, isFallback?: boolean }>}
 */
export function getOptions(detail) {
  const list = Array.isArray(detail?.prd?.attrTypList) ? detail.prd.attrTypList : [];
  if (list.length === 0) {
    // 2026-04-29 Codex Round 1 (PR #858 HIGH): attrTypList 누락 시 무조건 stock=0/
    // isSoldout=true 로 emit 하면 서버 ingest 가 verbatim 저장 → prdSaleSt='Y' 인
    // 정상 판매 상품도 영구 sold-out. 제품 단위 prdSaleSt 신호를 fallback option 의
    // stock/isSoldout 에 반영해 모순 제거.
    const productActive = String(detail?.prd?.prdSaleSt ?? '').toUpperCase() === SELL_STAT_AVAILABLE;
    return [
      {
        optionName: '기타',
        optionType: 'none',
        sku: String(detail?.prd?.prdCd ?? ''),
        // prdSaleSt='Y' (판매중) → stock=1/isSoldout=false. 그 외 (대기/품절/단종)
        // → stock=0/isSoldout=true. server ingest 의 verbatim 저장과 호환.
        stock: productActive ? 1 : 0,
        isSoldout: !productActive,
        priceDiff: 0,
        isFallback: true,
      },
    ];
  }
  // 단일 옵션 + attrTypVal 비어있음/'단품' → fallback semantics (정상 수집 가능).
  // 의류처럼 attrTypVal 가 의미있는 case 와 분리 필요.
  return list.map((opt) => {
    // attrTypVal: '색상\\b사이즈' or '단품' or ''
    const rawVal = String(opt?.attrTypVal ?? '').trim();
    let optionName = rawVal || '기타';
    let optionType = 'none';
    if (rawVal && rawVal !== '단품') {
      // \b (0x08) 가 multi-axis 구분자. ' / ' 로 정규화 (Lonit 표준).
      const axes = rawVal.split('\b').map(s => s.trim()).filter(Boolean);
      optionName = axes.join(' / ');
      // axis 가 2개 이상이면 'combo', 1 개면 single (size or color 추정 어려움 → 'option').
      optionType = axes.length >= 2 ? 'combo' : 'option';
    }
    const stockFlg = String(opt?.stockFlg ?? 'Y').toUpperCase();
    // GSshop 규약: stockFlg='N' → 재고 있음. 'Y' → 품절.
    const isSoldout = stockFlg !== 'N';
    return {
      optionName,
      optionType,
      sku: String(opt?.attrPrdCd ?? opt?.attrPrdRepCd ?? ''),
      // GSshop 은 옵션별 stock 수치 노출 없음 (재고있음/없음 binary). 보수적 stock=1
      // (재고 있음) / 0 (품절) 으로 정규화. downstream 이 isSoldout 만 신뢰.
      stock: isSoldout ? 0 : 1,
      isSoldout,
      // 옵션 가격차 노출 없음 (PDP UI 에서만 추가가산금 표시). Phase 2 에서 layer fetch.
      priceDiff: 0,
    };
  });
}

/**
 * 출고 소요일 추정 — renderJson.prd.dlvInfo.dlvHeadrInfo.addInfo1 텍스트 파싱.
 *
 * 정찰 fixture (3건):
 *   - "<span class='color-mint'>5. 8.(금)</span> <span>도착 예정</span>" → 5/8 도착 → ~3일
 *   - "배송일 : 상품상세설명 참조" → 알 수 없음 → fallback
 *   - "<span class='color-mint'>5. 7.(목)</span> <span>도착 예정</span>" → 5/7 도착 → ~2일
 *
 * Phase 2: 정확한 날짜 파싱 → 오늘과의 차이로 leadDays 산출. PoC 는 보수적 fallback.
 * lotteimall PR #852 패턴: isFallback flag 분리하여 server ingest 가 신뢰도 가시화.
 *
 * @param {any} detail   getDetail 결과
 * @returns {{ leadDays: number, isFallback: boolean }}
 */
export function getLeadDays(detail) {
  const text = String(detail?.prd?.dlvInfo?.dlvHeadrInfo?.addInfo1 ?? '');
  // "내일 도착" / "오늘 도착" — 1일 (확실)
  if (/내일\s*도착|오늘\s*도착/.test(text)) return { leadDays: 1, isFallback: false };
  // "M월 D일" 또는 "M. D.(요일) 도착 예정" — Phase 2 정확 파싱.
  // PoC 는 GSshop 평균 2-3일 (09 doc Section 6.B.4) 의 보수적 2일 + isFallback=true.
  return { leadDays: 2, isFallback: true };
}

// ─── 결과 정규화 ─────────────────────────────────────────────────────────────

/**
 * 검색 항목 + PDP detail → 표준 product 객체.
 *
 * 출력 shape 는 lotteon.js parseItem / abcmart.js parseItem 과 동일 (sourceMarket: 'gsshop').
 * server ingest layer (apps/api/src/modules/collect) 가 본 shape 를 받음.
 *
 * @param {any} searchItem  renderJsonPrdList.prdList[i]
 * @param {any} detail      getDetail 결과 (or null — 상세 fetch 실패 시 검색 데이터로만 구성)
 * @returns {object} 표준 product
 */
export function parseItem(searchItem, detail = null) {
  const prdid = String(searchItem?.productCd ?? detail?.prd?.prdCd ?? '');

  // 검색 fallback
  const searchName = String(searchItem?.productName ?? '');
  const searchBrand = String(searchItem?.brandNm ?? '');
  const searchImage = String(searchItem?.imageUrl ?? '');
  const searchBase = Number(searchItem?.basePrice ?? 0) || 0;
  const searchSell = Number(searchItem?.salePrice ?? searchBase) || 0;
  const searchSoldout = Boolean(searchItem?.isTempOut);
  const searchClsCd = String(searchItem?.prdClsCd ?? '');

  // 상세 우선
  const prd = detail?.prd || {};
  const pmo = detail?.pmo || {};
  const name = String(prd.prdNm ?? searchName).trim();
  const brand = String(prd.brandNm ?? searchBrand).trim();
  const brandCd = Number(prd.brandCd ?? 0) || 0;

  // 가격: pmo.prc.salePrc / pmo.gsPrc 가 정규. searchItem.basePrice/salePrice fallback.
  // basePrice (정가/정상가) vs salePrice (할인 후) 차이 반영.
  const sellAmt = Number(pmo?.prc?.salePrc ?? searchSell) || 0;
  // GSshop 의 'gsPrc' 는 personal/calc 가 (할인쿠폰 적용 후 표시 가격). 일반적으로 salePrc
  // 와 동일하나, 5% 쿠폰 같은 경우 다름. PoC 는 sellAmt = salePrc (정상 판매가) 기준.
  const normalAmt = searchBase > sellAmt ? searchBase : sellAmt;
  // 할인율 — 검색 응답에 명시 (discountRate). 상세에는 prcDcRt 가 있으나 -2147483648 같은
  // sentinel 값 (미할인 표기) 가 자주 나타남 → 검색 값 우선.
  const discount = Number(searchItem?.discountRate ?? 0) || 0;

  // 카테고리: prd.ctgrInfo.ssectNm (소분류) 우선, 없으면 msectNm/lsectNm. searchItem 의
  // prdClsCd (B23050501 같은 카테고리 코드) 는 별도 매핑 필요 → category-mapper 에서 처리.
  const ctgr = prd.ctgrInfo || {};
  const categorySource = String(
    ctgr.ssectNm ?? ctgr.msectNm ?? ctgr.lsectNm ?? searchClsCd ?? '',
  ).trim();

  // 이미지: prd.mediaInfo.images (PDP 메인 이미지 다수) 우선. 없으면 prd.imgInfo[].imgUrl,
  // 그래도 없으면 searchItem.imageUrl.
  const detailImages = Array.isArray(prd?.mediaInfo?.images)
    ? prd.mediaInfo.images.map(String).filter(s => s.startsWith('http'))
    : [];
  const imgInfoUrls = Array.isArray(prd?.imgInfo)
    ? prd.imgInfo.map(x => String(x?.imgUrl || '')).filter(s => s.startsWith('http'))
    : [];
  const imageCandidates = [...detailImages, ...imgInfoUrls];
  // dedup 보존순서
  const seenImages = new Set();
  const images = [];
  for (const img of imageCandidates) {
    if (!seenImages.has(img)) {
      seenImages.add(img);
      images.push(img);
    }
  }
  // 검색 fallback (모든 detail image 누락)
  if (images.length === 0 && searchImage) images.push(searchImage);
  const thumbnail = images[0] || '';

  // 옵션 / 재고
  const options = detail ? getOptions(detail) : [];
  const totalStock = options.reduce((sum, o) => sum + (o.stock || 0), 0);

  // isSoldout: prd.prdSaleSt='Y' 가 판매중. 그 외 (대기/품절/단종) 비활성.
  // search 의 isTempOut 또는 모든 옵션 품절도 sold-out.
  const detailSoldout = detail
    ? String(prd.prdSaleSt ?? '').toUpperCase() !== SELL_STAT_AVAILABLE
    : false;
  const optionsFallback = options.length > 0 && options.every(o => o?.isFallback);
  const allOptionsSoldout = !optionsFallback && options.length > 0 && options.every(o => o.isSoldout);
  const isSoldout = detailSoldout || searchSoldout || allOptionsSoldout;

  // 배송: prd.freeDlvFlg='Y' → 무료. 그 외 dlvcAmt 정수원.
  const freeDlv = String(prd.freeDlvFlg ?? '').toUpperCase() === 'Y';
  const dlvcAmt = Number(prd.dlvcAmt ?? 0) || 0;
  // searchItem.freeDlvYn='Y' (search-only fallback)
  const searchFreeDlv = String(searchItem?.freeDlvYn ?? '').toUpperCase() === 'Y';
  const shippingType = !detail
    ? (searchFreeDlv ? 'free' : 'paid')
    : (freeDlv ? 'free' : 'paid');
  const shippingFee = !detail
    ? 0  // 검색만으로 배송비 정확 산출 어려움 — 보수적 0
    : (freeDlv ? 0 : dlvcAmt);

  // sourceLeadDays: getLeadDays fallback semantics (lotteimall 패턴).
  const leadInfo = detail ? getLeadDays(detail) : { leadDays: 2, isFallback: true };
  const sourceLeadDays = leadInfo.isFallback ? null : leadInfo.leadDays;

  return {
    sourceMarket: 'gsshop',
    sourceId: prdid,
    sourceUrl: `${PDP_URL}?prdid=${prdid}`,
    brand,
    originalTitle: name,
    originalPrice: normalAmt,
    sellPrice: sellAmt,
    couponPrice: 0, // Phase 2: 카드 즉시할인 / GS&POINT 통합
    discount,
    categorySource,
    thumbnail,
    images,
    specs: {
      ...(brandCd ? { brandCd: String(brandCd) } : {}),
      ...(searchClsCd ? { prdClsCd: searchClsCd } : {}),
    },
    options,
    totalStock,
    isSoldout,
    reviewScore: Number(searchItem?.reviewAverage ?? detail?.prdrevw?.avgScore ?? 0) || 0,
    reviewCount: Number(searchItem?.reviewCount ?? detail?.prdrevw?.prdrevwTotCnt ?? 0) || 0,
    storeName: 'GSshop',
    todayArrive: /내일\s*도착|오늘\s*도착/.test(String(prd?.dlvInfo?.dlvHeadrInfo?.addInfo1 ?? '')),
    benefitPrice: null,         // Phase 2: GS&POINT 적립가
    cardBenefitPrice: null,     // Phase 2: 카드 즉시할인
    benefitDetails: null,
    // 2026-05-18: 정보고시 — GSshop PDP 의 표준 필드. detail.brand_name/sku 안전 접근.
    productNotices: {
      brand: String(prd?.brandNm || ''),
      manufacturer: String(prd?.brandNm || 'GS샵'),
      importer: 'GS샵 (주식회사 GS홈쇼핑)',
      manufactureCountry: '상세설명 참조',
      material: '상세설명 참조',
      warranty: '소비자분쟁해결기준 (공정거래위원회 고시)',
      asContact: 'GS샵 고객센터 1577-1700',
    },
    shippingType,
    shippingFee,
    sourceLeadDays,
    // lotteimall 패턴: PoC fallback 영역 가시화 → server ingest 가 신뢰도 판단 가능.
    isFallback: {
      options: optionsFallback,
      leadDays: !!leadInfo?.isFallback,
      benefitPrice: true,       // Phase 2 에서 false 로 전환
      productNotices: true,
    },
  };
}

// ─── 메인 collect ────────────────────────────────────────────────────────────

/**
 * GSshop 검색→수집 메인 진입점.
 *
 * @param {string} url           검색 URL 또는 PDP URL
 * @param {number} limit         최대 수집 건수
 * @param {Function} onProgress  진행률 콜백 (percent, total, sent, message)
 * @param {object} options       { onBatch, signal }
 * @returns {Promise<Array<object>>} 수집된 product 배열
 */
export async function collect(url, limit = 100, onProgress = () => {}, options = {}) {
  const parsed = parseUrl(url);
  let searchItems = [];

  if (parsed.prdid) {
    // 단일 PDP URL → 1 상품 collect (검색 데이터 없음 → detail 만으로 parseItem)
    searchItems = [{ productCd: parsed.prdid }];
  } else if (parsed.keyword) {
    onProgress(0, 0, 0, 'GSshop 검색중...');

    // ── 1단계: 검색 결과 ──
    let resp;
    try {
      resp = await searchProducts({ keyword: parsed.keyword, signal: options?.signal });
    } catch (err) {
      console.error(`[BulkFlow GSshop] 검색 실패:`, err.message);
      return [];
    }
    if (resp.items.length === 0) {
      onProgress(100, 0, 0, '검색 결과 없음');
      return [];
    }
    // dedup productCd + limit cap
    const seen = new Set();
    for (const it of resp.items) {
      const id = String(it?.productCd ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      searchItems.push(it);
      if (searchItems.length >= limit) break;
    }
    onProgress(20, resp.items.length, searchItems.length, `검색: ${searchItems.length}/${limit}`);
  } else {
    console.error('[BulkFlow GSshop] URL 파싱 실패:', url);
    return [];
  }

  if (searchItems.length === 0) {
    onProgress(100, 0, 0, '검색 결과 없음');
    return [];
  }

  console.log(`[BulkFlow GSshop] 검색 완료: ${searchItems.length}개 → ${STREAM_BATCH}개씩 상세 처리`);

  // ── 2단계: STREAM_BATCH 단위 상세 + 정규화 + onBatch 전송 ──
  const allProducts = [];
  let totalSent = 0;

  for (let batchStart = 0; batchStart < searchItems.length; batchStart += STREAM_BATCH) {
    if (options?.signal?.aborted) break;
    const batchItems = searchItems.slice(batchStart, batchStart + STREAM_BATCH);
    const batchNum = Math.floor(batchStart / STREAM_BATCH) + 1;
    const totalBatches = Math.ceil(searchItems.length / STREAM_BATCH);

    console.log(`[BulkFlow GSshop] 배치 ${batchNum}/${totalBatches}: ${batchItems.length}개 처리중`);

    // 상세 — 직렬 (rate-limiter 가 분당 30 자체 제어). 차단 0 보장 우선.
    const batchProducts = [];
    for (const item of batchItems) {
      if (options?.signal?.aborted) break;
      let detail = null;
      try {
        detail = await getDetail(item.productCd, { signal: options?.signal });
      } catch (err) {
        if (err?.message === 'aborted') break;
        console.warn(`[BulkFlow GSshop] 상세 ${item.productCd} 실패:`, err.message);
        // 상세 실패해도 검색 데이터로만 product 구성 (degraded mode).
      }
      // 단일 PDP collect 인데 detail null 이면 의미 있는 데이터가 없음 → drop.
      if (!detail && !item.productName) {
        console.warn(`[BulkFlow GSshop] 단일 PDP detail 누락 — 건너뜀 (productCd=${item.productCd})`);
        continue;
      }
      batchProducts.push(parseItem(item, detail));
    }

    // 배치 단위 서버 전송 (서비스 워커 crash 안전)
    if (options?.onBatch && batchProducts.length) {
      try {
        await options.onBatch(batchProducts);
        totalSent += batchProducts.length;
      } catch (e) {
        console.error(`[BulkFlow GSshop] 배치 ${batchNum} 전송 실패:`, e.message);
      }
    }
    allProducts.push(...batchProducts);

    const progress = 20 + Math.round(((batchStart + batchItems.length) / searchItems.length) * 80);
    onProgress(
      progress,
      searchItems.length,
      totalSent || allProducts.length,
      `처리: ${allProducts.length}/${searchItems.length}`,
    );
  }

  const withOptions = allProducts.filter(p => p.options && p.options.length > 1).length;
  onProgress(100, allProducts.length, allProducts.length, '수집 완료');
  console.log(`[BulkFlow GSshop] 완료: ${allProducts.length}개 (다중옵션: ${withOptions})`);
  return allProducts;
}

/**
 * 임시 탭 정리 — GSshop 은 비로그인 fetch 만 사용 → noop.
 * Phase 2: 회원가/등급할인 fetch 시 chrome.tabs API 사용했다면 정리.
 */
export function cleanupGsshopTab() {
  // noop
}
