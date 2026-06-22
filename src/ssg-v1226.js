// 목적: SSG.com 수집 엔진 — API fetch 방식 (search.ssg.com/api/item/all)
// 검색 API: POST https://search.ssg.com/api/item/all (JSON, 40개/페이지)
// 상세: HTML fetch + resultItemObj / uitemObjArr regex 파싱
// 이미지: sitem.ssgcdn.com CDN URL 패턴

const SEARCH_URL = 'https://search.ssg.com/api/item/all';
const DETAIL_BASE = 'https://www.ssg.com/item/itemView.ssg';
const IMG_CDN = 'https://sitem.ssgcdn.com';
const PAGE_SIZE = 40;
const CONCURRENCY = 1;
// 2026-05-17 사용자 신고 "SSG 수집 속도가 엄청 느려" — 보수적 ratelimit 완화. ssg.js 와 동기화.
const DETAIL_MIN_DELAY_MS = 1500;
const DETAIL_START_DELAY_MS = 2000;
const DETAIL_MAX_DELAY_MS = 60_000;
const DETAIL_JITTER_MS = 600;
const DETAIL_SPEED_UP_EVERY = 10;
const DETAIL_SPEED_UP_FACTOR = 0.85;
const DETAIL_SLOW_DOWN_FACTOR = 2.0;
const DETAIL_BLOCK_COOLDOWN_MS = 5 * 60_000;
const SEARCH_PARAM_ALLOWLIST = ['repBrandId', 'shpp', 'sort', 'ctgId', 'ctgLv', 'dispCtgId'];
const ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS = 6;
const KOREA_DELIVERY_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-03-02',
  '2026-05-01',
  '2026-05-05',
  '2026-05-25',
  '2026-06-03',
  '2026-06-06',
  '2026-08-15',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-10-03',
  '2026-10-05',
  '2026-10-09',
  '2026-12-25',
]);

let ssgDetailBlockedUntil = 0;
let ssgDetailDelayMs = DETAIL_START_DELAY_MS;
let ssgDetailSuccesses = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

async function waitSsgDetailSlot(useContentScript = false) {
  const remainingCooldownMs = ssgDetailBlockedUntil - Date.now();
  if (remainingCooldownMs > 0) {
    console.warn(`[SSG] 상세조회 차단 쿨다운 대기 ${Math.ceil(remainingCooldownMs / 1000)}초`);
    await sleep(remainingCooldownMs);
  }

  if (useContentScript) {
    await sleep(700);
    return;
  }

  await sleep(ssgDetailDelayMs + randomBetween(0, DETAIL_JITTER_MS));
}

function markSsgDetailBlocked(reason = 'blocked') {
  ssgDetailDelayMs = Math.min(DETAIL_MAX_DELAY_MS, Math.max(DETAIL_MIN_DELAY_MS, Math.floor(ssgDetailDelayMs * DETAIL_SLOW_DOWN_FACTOR)));
  ssgDetailSuccesses = 0;
  ssgDetailBlockedUntil = Date.now() + DETAIL_BLOCK_COOLDOWN_MS;
  console.warn(`[SSG] 상세조회 차단 감지: ${reason}. delay=${ssgDetailDelayMs}ms, ${Math.round(DETAIL_BLOCK_COOLDOWN_MS / 1000)}초 쿨다운`);
}

function markSsgDetailSuccess() {
  ssgDetailSuccesses++;
  if (ssgDetailSuccesses < DETAIL_SPEED_UP_EVERY) return;
  ssgDetailSuccesses = 0;
  const nextDelay = Math.max(DETAIL_MIN_DELAY_MS, Math.floor(ssgDetailDelayMs * DETAIL_SPEED_UP_FACTOR));
  if (nextDelay < ssgDetailDelayMs) {
    console.log(`[SSG] 상세조회 속도 증가: ${ssgDetailDelayMs}ms → ${nextDelay}ms`);
    ssgDetailDelayMs = nextDelay;
  }
}

export function isSsgBlockedHtml(html = '') {
  const body = String(html || '');
  if (!body) return false;
  return [
    /연속적인\s*접근/i,
    /페이지가\s*잠시\s*멈췄어요/i,
    /보안\s*퀴즈/i,
    /서비스\s*계속하기/i,
    /비정상적인\s*접근/i,
    /잠시\s*후\s*다시\s*이용/i,
    /서비스\s*이용에\s*불편/i,
    /reCaptcha|verifyCaptcha|captcha|Access Denied|Bot Detection/i,
  ].some((pattern) => pattern.test(body));
}

function hasUsableSsgDetail(detail) {
  if (!detail || detail.detailFetchBlocked || detail.optionsReliable === false) return false;
  return Boolean(
    detail.options?.length > 0 ||
    detail.cardBenefitPrice != null ||
    detail.productData?.bestAmt ||
    detail.productData?.sellprc ||
    detail.sourceLeadDays != null ||
    detail.productNotices?.length > 0 ||
    detail.detailImages?.length > 0,
  );
}

function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isKoreaDeliveryBusinessDay(date) {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && !KOREA_DELIVERY_HOLIDAYS.has(formatLocalDateKey(date));
}

export function businessDaysUntilMonthDay(mm, dd, now = new Date()) {
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(today.getFullYear(), mm - 1, dd);
  if (target.getTime() < today.getTime() - 86400000) target.setFullYear(today.getFullYear() + 1);
  if (target.getTime() <= today.getTime()) return 0;

  let count = 0;
  let loops = 0;
  for (let cursor = new Date(today.getTime() + 86400000); cursor <= target && loops < 60; cursor = new Date(cursor.getTime() + 86400000), loops++) {
    if (isKoreaDeliveryBusinessDay(cursor)) count++;
  }
  return count;
}

export function arrivalBusinessDaysToOutboundLeadDays(arrivalBusinessDays) {
  const n = Math.floor(Number(arrivalBusinessDays));
  if (!Number.isFinite(n) || n < 0 || n > 30 + ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS) return null;
  return Math.max(1, Math.min(30, n - ARRIVAL_TO_OUTBOUND_BUFFER_BUSINESS_DAYS));
}

function isArrivalLeadLabel(label = '') {
  return /도착|배송|arrival|arriv|delivery|dlv|expect/i.test(label)
    && !/출고|발송|ship|release/i.test(label);
}

export function normalizeSourceLeadDays(days, label = '') {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  const clamped = Math.max(1, n);
  return isArrivalLeadLabel(label) ? arrivalBusinessDaysToOutboundLeadDays(clamped) : clamped;
}

function decodeHtmlEntities(text = '') {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function cleanSsgOptionText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function compactSsgOptionText(value = '') {
  return cleanSsgOptionText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s()[\]{}_\-:/|.,'"`]+/g, '');
}

function isDisplayOnlySsgOptionName(optionName = '', itemName = '') {
  const clean = cleanSsgOptionText(optionName);
  if (!clean) return true;
  if (clean.includes('\uB300\uD45C\uB2E8\uD488')) return true;

  const optionKey = compactSsgOptionText(clean);
  const itemKey = compactSsgOptionText(itemName);
  if (!optionKey) return true;
  if (!itemKey) return false;
  if (optionKey === itemKey) return true;
  return clean.length >= 20 && (optionKey.includes(itemKey) || itemKey.includes(optionKey));
}

function pickSsgOptionName(get, itemName = '') {
  const parts = ['uitemOptnNm1', 'uitemOptnNm2', 'uitemOptnNm3']
    .map((key) => cleanSsgOptionText(get(key)))
    .filter((value) => value && !isDisplayOnlySsgOptionName(value, itemName));
  const uniqueParts = [...new Set(parts)];
  if (uniqueParts.length > 0) return uniqueParts.join(' / ');

  const fallback = cleanSsgOptionText(get('uitemNm'));
  return isDisplayOnlySsgOptionName(fallback, itemName) ? '' : fallback;
}

function dedupeSsgOptions(options = []) {
  const byName = new Map();
  for (const option of options) {
    const key = cleanSsgOptionText(option?.optionName);
    if (!key) continue;
    const previous = byName.get(key);
    if (!previous) {
      byName.set(key, { ...option, optionName: key });
      continue;
    }
    previous.stock = Number(previous.stock || 0) + Number(option.stock || 0);
    previous.isSoldout = Boolean(previous.isSoldout) && Boolean(option.isSoldout);
  }
  return [...byName.values()];
}

function safeDecodeUrl(value = '') {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function normalizeSsgImageUrl(raw = '') {
  let url = decodeHtmlEntities(String(raw || '').trim());
  if (!url || url.startsWith('data:')) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('/')) url = `https://itemdesc.ssg.com${url}`;
  if (!/^https?:\/\//i.test(url)) return null;
  return url.replace(/([?#]).*$/, '');
}

function extractSsgImgTags(html = '') {
  const tags = String(html || '').match(/<img\s[^>]*>/gi) || [];
  return tags.flatMap((tag) => {
    const getAttr = (name) => {
      const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
      return match ? decodeHtmlEntities(match[1]).trim() : '';
    };
    const src = normalizeSsgImageUrl(
      getAttr('data-src') || getAttr('data-original') || getAttr('data-lazy') || getAttr('src'),
    );
    if (!src) return [];
    return [{
      src,
      alt: getAttr('alt'),
      className: getAttr('class'),
    }];
  });
}

function isSsgSizeGuideImage(entry) {
  const target = `${safeDecodeUrl(entry.src)} ${entry.alt} ${entry.className}`.toLowerCase();
  return /size|measure|measurement|sizetable|sizeguide|\uC0AC\uC774\uC988|\uCE58\uC218|\uC2E4\uCE21|\uCE21\uC815|\uADDC\uACA9/.test(target);
}

function isSsgNonProductDetailImage(entry) {
  const target = `${safeDecodeUrl(entry.src)} ${entry.alt} ${entry.className}`.toLowerCase();
  if (/_i\d+_\d+\.(?:jpe?g|png|webp|gif)$/i.test(target)) return true;
  return [
    /(?:^|[\/_.-])(?:logo|icon|ico|btn|button|sprite|blank|spacer)(?:[\/_.-]|$)/,
    /(?:banner|bnr|event|coupon|benefit|membership|promotion|promo|sale|gift|review)/,
    /(?:notice|noti|mustread|readme|caution|warning|guide|cs|customer|center)/,
    /(?:delivery|shipping|return|refund|exchange|claim|ascenter|afterservice)/,
    /(?:authorized|dealer|official|genuine|auth|certification|certified)/,
    /(?:seemore|see_more|moreview|todaygogo|today|gogo)/,
    /(?:kakao|talk|naver|store|appdown|download)/,
    /(?:\uB85C\uACE0|\uC544\uC774\uCF58|\uBC30\uB108|\uACF5\uC9C0|\uD544\uB3C5|\uC8FC\uC758|\uBC18\uD488|\uAD50\uD658|\uBC30\uC1A1|\uCFE0\uD3F0|\uD61C\uD0DD|\uC778\uC99D|\uC815\uD488)/,
  ].some((pattern) => pattern.test(target));
}

export function extractSsgDetailMedia(html = '') {
  const detailImages = [];
  const sizeGuideImages = [];
  const seen = new Set();

  for (const entry of extractSsgImgTags(html)) {
    if (seen.has(entry.src)) continue;
    seen.add(entry.src);

    if (isSsgSizeGuideImage(entry)) {
      sizeGuideImages.push(entry.src);
      continue;
    }

    if (isSsgNonProductDetailImage(entry)) continue;
    detailImages.push(entry.src);
  }

  return {
    detailImages: detailImages.slice(0, 30),
    sizeGuideImages: sizeGuideImages.slice(0, 10),
  };
}

function normalizeBrandName(brand = '') {
  return String(brand || '').replace(/\s+/g, '').trim().toLowerCase();
}

function extractAllowedBrandsFromHtml(html = '', repBrandIds = []) {
  const ids = new Set(repBrandIds.map((id) => String(id || '').trim()).filter(Boolean));
  const names = new Set();
  if (ids.size === 0 || !html) return [];

  const jsonPattern = /repBrandId","value":"([^"]+)","name":"([^"]+)"/g;
  let match;
  while ((match = jsonPattern.exec(html)) !== null) {
    if (ids.has(match[1])) {
      names.add(decodeHtmlEntities(match[2]));
    }
  }

  if (names.size > 0) return [...names];

  const chipPattern = /aria-label="([^"]+)\s필터 삭제"/g;
  while ((match = chipPattern.exec(html)) !== null) {
    names.add(decodeHtmlEntities(match[1]));
  }

  return [...names];
}

async function resolveAllowedBrands(searchUrl = '', filters = {}) {
  const repBrandIds = String(filters.repBrandId || '')
    .split('|')
    .map((id) => id.trim())
    .filter(Boolean);

  if (!searchUrl || repBrandIds.length === 0) return [];

  try {
    const headers = await getSsgHeaders();
    const res = await fetch(searchUrl, { headers });
    if (res.status === 429 || res.status === 403) {
      markSsgDetailBlocked(`HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (isSsgBlockedHtml(html)) {
      markSsgDetailBlocked('captcha/html');
      throw new Error('SSG detail captcha/html block');
    }
    const allowedBrands = extractAllowedBrandsFromHtml(html, repBrandIds);
    if (allowedBrands.length > 0) return allowedBrands;
    console.warn(`[SSG] 브랜드 필터명 해석 실패: repBrandId=${repBrandIds.join('|')}`);
  } catch (err) {
    console.warn('[SSG] 브랜드 필터 조회 실패:', err.message);
  }

  return [];
}

function partitionByAllowedBrands(items, allowedBrands = []) {
  if (!allowedBrands.length) {
    return { allowed: items, rejected: [] };
  }

  const allowedSet = new Set(allowedBrands.map(normalizeBrandName));
  const allowed = [];
  const rejected = [];

  for (const item of items) {
    const normalizedBrand = normalizeBrandName(item?.brand);
    if (normalizedBrand && allowedSet.has(normalizedBrand)) {
      allowed.push(item);
    } else {
      rejected.push(item);
    }
  }

  return { allowed, rejected };
}

// 서비스워커에서 SSG 쿠키 수동 주입 (credentials:'include' 대체)
async function getSsgHeaders() {
  const base = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const cookies = await chrome.cookies.getAll({ domain: '.ssg.com' });
      if (cookies.length > 0) {
        const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
        return { ...base, 'Cookie': cookieStr };
      }
    }
  } catch {}
  return base;
}

// ─── specs 파싱 헬퍼 ──────────────────────────────────────────────────────────

/**
 * productNotices 배열에서 소재/색상/핏/계절 specs 추출
 * 쿠팡 SEO에 필요한 핵심 속성을 파싱한다.
 * @param {Array<{key: string, value: string}>} notices
 * @returns {Record<string, string>}
 */
function extractSpecsFromNotices(notices) {
  if (!notices || notices.length === 0) return {};
  const specs = {};
  const SPEC_KEYS = {
    '소재': ['소재', '재질', '원단', '원재료', '혼용율', '구성', '성분'],
    '색상': ['색상', '컬러', 'color', '색'],
    '핏': ['핏', '실루엣', '핏감', 'fit'],
    '계절': ['계절', '시즌', '출시시즌', '적합계절'],
  };
  for (const notice of notices) {
    const key = (notice.key || '').toLowerCase().trim();
    const val = (notice.value || '').trim();
    if (!val || val === '-' || val === '해당없음' || val === '상세페이지 참조') continue;
    for (const [specKey, aliases] of Object.entries(SPEC_KEYS)) {
      if (specs[specKey]) continue; // 이미 채워진 경우 스킵
      if (aliases.some(alias => key.includes(alias.toLowerCase()))) {
        specs[specKey] = val.length > 50 ? val.slice(0, 50) : val;
        break;
      }
    }
  }
  return specs;
}

// ─── 검색 API ─────────────────────────────────────────────────────────────────

/** 검색 API 호출 → 상품 목록 */
async function fetchSearchPage(keyword, page = 1, extraParams = {}) {
  const body = {
    siteNo: '6009',
    query: keyword,
    page,
    target: 'pc_item',
    aplTgtMediaCd: '10',
    count: String(PAGE_SIZE),
    directYn: 'N',
    recomIndex: 0,
    shpp: 'department',
    sort: 'best',
    ...extraParams,
  };

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 쿠키 필요할 수 있음 → credentials 재시도
    const res2 = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res2.ok) throw new Error(`검색 API HTTP ${res2.status}`);
    return res2.json();
  }
  return res.json();
}

export function parseSearchUrl(searchUrl = '') {
  const parsed = {
    keyword: '',
    filters: {},
  };

  if (!searchUrl) return parsed;

  try {
    const u = new URL(searchUrl);
    parsed.keyword = u.searchParams.get('query') || u.searchParams.get('q') || '';

    for (const key of SEARCH_PARAM_ALLOWLIST) {
      const value = u.searchParams.get(key);
      if (value) parsed.filters[key] = value;
    }
  } catch {
    // ignore malformed searchUrl
  }

  return parsed;
}

/** 검색 결과 파싱 → 상품 배열 */
function parseSearchResults(apiData) {
  const items = [];
  if (!apiData?.data?.dataList) return { items, totalPages: 0, totalCount: 0 };

  let totalPages = 1;
  let totalCount = 0;

  for (const unit of apiData.data.dataList) {
    if (unit.unitType === 'ITEM_UNIT_LIST' && unit.dataList) {
      for (const raw of unit.dataList) {
        const itemId = raw.itemId || '';
        if (!itemId) continue;

        const siteNo = raw.siteNo || '6009';
        const thumbnail = raw.itemImgUrl || '';

        const explicitSoldout = raw.soldOutYn === 'Y' || raw.stoppedSellingYn === 'Y';
        const rawQty = raw.usablInvQty;
        const hasQty = rawQty !== undefined && rawQty !== null && rawQty !== '';
        const parsedQty = hasQty ? Number(rawQty) : null;
        const stock = Number.isFinite(parsedQty)
          ? Math.max(0, parsedQty)
          : (explicitSoldout ? 0 : 10);

        items.push({
          sourceId: itemId,
          sourceMarket: 'ssg',
          sourceUrl: `https://www.ssg.com/item/itemView.ssg?itemId=${itemId}&siteNo=${siteNo}`,
          originalTitle: raw.itemNm || '',
          brand: raw.brandNm || '',
          originalPrice: parseInt(raw.strikeOutPrc || raw.displayPrc || '0', 10),
          sellPrice: parseInt(raw.displayPrc || '0', 10),
          couponPrice: parseInt(raw.displayPrc || '0', 10),
          images: thumbnail ? [thumbnail] : [],
          categorySource: raw.stdCtgNm || raw.ctgNm || raw.lrgCtgNm || '',
          specs: {},
          isSoldout: explicitSoldout || (hasQty && stock === 0),
          totalStock: Math.min(stock, 10),
          rawTotalStock: hasQty ? stock : (explicitSoldout ? 0 : null),
          stockReliable: hasQty || explicitSoldout,
          ssgStockReliableV2: hasQty || explicitSoldout,
          _siteNo: siteNo,
          _salestrNo: raw.salestrNo || '',
        });
      }
    }

    if (unit.unitType === 'PAGING_UNIT') {
      totalPages = unit.totalPage || 1;
      totalCount = unit.itemCount || 0;
    }
  }

  return { items, totalPages, totalCount };
}

// ─── 상세 API (HTML 파싱) ─────────────────────────────────────────────────────

// 탭 재사용 풀
let _ssgTabId = null;

function waitForSsgTabLoad(tabId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500); // SSR이라 짧게
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export function cleanupSsgTab() {
  if (_ssgTabId) { chrome.tabs.remove(_ssgTabId).catch(() => {}); _ssgTabId = null; }
}

// Content Script 방식 — 탭 재사용 + 로드 감지
async function fetchDetailViaTab(url) {
  if (_ssgTabId) {
    try { await chrome.tabs.get(_ssgTabId); await chrome.tabs.update(_ssgTabId, { url }); }
    catch { const tab = await chrome.tabs.create({ url, active: false }); _ssgTabId = tab.id; }
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    _ssgTabId = tab.id;
  }

  await waitForSsgTabLoad(_ssgTabId);

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: _ssgTabId },
      func: () => {
        const html = document.documentElement.outerHTML;
        const visibleText = (document.body && document.body.textContent) || '';
        if (/연속적인\s*접근|페이지가\s*잠시\s*멈췄어요|보안\s*퀴즈|서비스\s*계속하기|비정상적인\s*접근|서비스\s*이용에\s*불편|reCaptcha|verifyCaptcha|captcha|Access Denied|Bot Detection/i.test(`${html}\n${visibleText}`)) {
          return {
            options: [],
            optionsReliable: false,
            detailFetchBlocked: true,
            blockReason: 'SSG detail captcha/html block',
          };
        }

        // resultItemObj
        let productData = {};
        const cleanSsgOptionTextLocal = (value = '') => String(value ?? '').replace(/\s+/g, ' ').trim();
        const compactSsgOptionTextLocal = (value = '') => cleanSsgOptionTextLocal(value)
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[\s()[\]{}_\-:/|.,'"`]+/g, '');
        const isDisplayOnlySsgOptionNameLocal = (optionName = '', itemName = '') => {
          const clean = cleanSsgOptionTextLocal(optionName);
          if (!clean) return true;
          if (clean.includes('\uB300\uD45C\uB2E8\uD488')) return true;
          const optionKey = compactSsgOptionTextLocal(clean);
          const itemKey = compactSsgOptionTextLocal(itemName);
          if (!optionKey) return true;
          if (!itemKey) return false;
          if (optionKey === itemKey) return true;
          return clean.length >= 20 && (optionKey.includes(itemKey) || itemKey.includes(optionKey));
        };
        const pickSsgOptionNameLocal = (get, itemName = '') => {
          const parts = ['uitemOptnNm1', 'uitemOptnNm2', 'uitemOptnNm3']
            .map((key) => cleanSsgOptionTextLocal(get(key)))
            .filter((value) => value && !isDisplayOnlySsgOptionNameLocal(value, itemName));
          const uniqueParts = [...new Set(parts)];
          if (uniqueParts.length > 0) return uniqueParts.join(' / ');
          const fallback = cleanSsgOptionTextLocal(get('uitemNm'));
          return isDisplayOnlySsgOptionNameLocal(fallback, itemName) ? '' : fallback;
        };
        const itemMatch = html.match(/var\s+resultItemObj\s*=\s*\{([\s\S]*?)\};/);
        if (itemMatch) {
          try {
            const extract = (key) => { const m = itemMatch[1].match(new RegExp(key + "\\s*:\\s*['\"]([^'\"]*)")); return m ? m[1] : ''; };
            const extractNum = (key) => { const m = itemMatch[1].match(new RegExp(key + "\\s*:\\s*(?:parseInt\\()?['\"]?(\\d+)")); return m ? parseInt(m[1]) : 0; };
            const dlvTextMatch = html.match(/(?:배송비|택배비)[^\d]{0,30}([\d,]+)\s*원/);
            const textDlvCst = dlvTextMatch ? parseInt(dlvTextMatch[1].replace(/,/g, ''), 10) : 0;
            productData = { itemNm: extract('itemNm'), brandNm: extract('brandNm'), sellprc: extractNum('sellprc'), bestAmt: extractNum('bestAmt'), soldOut: extract('soldOut'), dlvCst: extractNum('dlvCst') || textDlvCst, freeDlvYn: extract('freeDlvYn') };
          } catch {}
        }

        // 옵션
        const options = [];
        const ms = html.matchAll(/uitemObj\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g);
        for (const m of ms) {
          const s = m[1];
          const get = (k) => { const mm = s.match(new RegExp(k + "\\s*:\\s*'([^']*)")); return mm ? mm[1] : ''; };
          const getNum = (k) => { const mm = s.match(new RegExp(k + "\\s*:\\s*'?(\\d+)")); return mm ? parseInt(mm[1]) : 0; };
          const nm = pickSsgOptionNameLocal(get, productData.itemNm || '');
          if (!nm || nm === '대표단품') continue;
          options.push({ optionName: nm, optionType: get('uitemOptnTypeNm1') || 'size', optionGroupIndex: 0, parentId: null, sku: get('uitemId'), stock: getNum('usablInvQty'), isSoldout: get('soldOutYn') === 'Y' || getNum('usablInvQty') === 0, priceDiff: getNum('addPrc') || 0 });
        }

        // 이미지
        const images = [];
        const seen = new Set();
        const imgMs = html.matchAll(/https?:\/\/sitem\.ssgcdn\.com[^\s"']+_i\d+_\d+\.(?:jpg|png|webp)/gi);
        for (const im of imgMs) { const n = im[0].replace(/_i(\d+)_\d+\./, '_i$1_500.'); if (!seen.has(n)) { seen.add(n); images.push(n); } }

        // 카드혜택가 — 로그인 상태에서 정확한 값
        const cardMatch = html.match(/mndtl_card_price[\s\S]*?ssg_price">\s*([\d,]+)\s*<\/em>/);
        const cardPrice = cardMatch ? parseInt(cardMatch[1].replace(/,/g, '')) : null;
        // 개별 <dl> 블록 단위로 카드 혜택 파싱 (greedy 방지)
        const cardDetails = [];
        const blockRx = /<dl[^>]*class="[^"]*cdtl_card_dl[^"]*"[^>]*>([\s\S]*?)<\/dl>/g;
        let cm;
        while ((cm = blockRx.exec(html)) !== null) {
          const blk = cm[1];
          const nm = blk.match(/<dt[^>]*>([\s\S]*?)<\/dt>/);
          const pr = blk.match(/ssg_price">\s*([\d,]+)\s*<\/em>/);
          if (nm && pr) {
            const p = parseInt(pr[1].replace(/,/g, ''));
            if (p >= 1000 && p <= 10000000) cardDetails.push({ card: nm[1].replace(/<[^>]+>/g, '').trim(), price: p });
          }
        }

        // 상품필수정보 파싱
        const productNotices = [];
        const specTable = html.match(/상품필수정보[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
        if (specTable) {
          const rowRegex = /<th[^>]*>\s*(?:<div[^>]*>)?([\s\S]*?)(?:<\/div>)?\s*<\/th>\s*<td>\s*(?:<div[^>]*>)?([\s\S]*?)(?:<\/div>)?\s*<\/td>/g;
          let rm;
          while ((rm = rowRegex.exec(specTable[1])) !== null) {
            const key = rm[1].replace(/<[^>]+>/g, '').trim();
            const val = rm[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();
            if (key && val) productNotices.push({ key, value: val });
          }
        }

        // specs 파싱: 상품필수정보에서 소재/색상/핏/계절 등 추출
        const specs = {};
        const SPEC_KEYS_TAB = ['소재', '재질', '혼용률', '색상', '사이즈', '핏', '계절', '시즌', '제조국', '원산지', '제조자', '제조사', '품번', '모델번호', '성별'];
        for (const notice of productNotices) {
          const key = (notice.key || '').trim();
          const val = (notice.value || '').trim();
          if (!key || !val || val === '상세페이지 참조' || val === '상세설명참조' || val === '해당없음' || val === '해당사항 없음') continue;
          const matched = SPEC_KEYS_TAB.find(sk => key.includes(sk));
          if (matched) {
            const norm = key.includes('재질') ? '소재' : key.includes('원산지') ? '제조국' : key.includes('시즌') ? '계절' : matched;
            if (!specs[norm]) specs[norm] = val;
          }
        }

        // categorySource: breadcrumb에서 추출
        let categorySource = '';
        const bcEl = document.querySelector('.location_bx ul');
        if (bcEl) {
          const links = bcEl.querySelectorAll('li a');
          const crumbs = [];
          links.forEach(a => {
            const t = a.textContent.trim();
            if (t && t !== 'HOME' && t !== '홈') crumbs.push(t);
          });
          if (crumbs.length > 0) categorySource = crumbs.join(' > ');
        }

        // 2026-04-21 hotfix: try/catch 구조가 Chrome V8 ESM service worker parser 에서
        //   "Unexpected token '}'" syntax error 유발 (원인 PR #532 이후 확정). 결과: background.js
        //   import chain 전체 실패 → service worker 등록 안 됨 → 수집 정지 5일+. try/catch
        //   제거 + null-safe 접근으로 동일 동작 (document 는 content script 환경이라 항상 존재,
        //   badge/text/match 전부 이미 null-safe).
        let sourceLeadDays = null;
        // 2026-04-22 (v1.2.2): 기존 `.cdtl_delivery` selector + body.textContent 만으로는
        //   SSG SPA 의 async 렌더 구간을 놓침 (11,812건 전수 NULL). 아래 3-stage fallback:
        //     1) badge selector 확대 (SSG 최근 클래스명 포함)
        //     2) document 전체 HTML (script tag 내부 hydrated JSON 포함) regex 스캔
        //     3) window.__NEXT_DATA__ / __INITIAL_STATE__ / _SSG 전역 객체 JSON stringify 스캔
        const badgeNode = document.querySelector(
          '.cdtl_delivery, .cdtl_dlv, .cdtl_row_delivery, .cdtl_info_delivery, [class*="Delivery"], [class*="Shipping"], [data-testid*="delivery" i]'
        );
        const bodyText = (badgeNode && badgeNode.textContent) || (document.body && document.body.textContent) || '';
        const fullHtml = (document.documentElement && document.documentElement.outerHTML) || '';
        const nextData = (() => {
          try {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : '';
          } catch { return ''; }
        })();
        const globalState = (() => {
          try {
            const g = window.__INITIAL_STATE__ || window.__NUXT__ || window._SSG || null;
            return g ? JSON.stringify(g) : '';
          } catch { return ''; }
        })();
        const searchCorpus = [bodyText, nextData, globalState, fullHtml].filter(Boolean);

        const testAny = (re) => searchCorpus.some((c) => re.test(c));
        const matchAny = (re) => {
          for (const c of searchCorpus) {
            const m = c.match(re);
            if (m) return m;
          }
          return null;
        };

        if (testAny(/내일(?:[(（][^)）]+[)）])?\s*(?:도착|배송)/)) {
          sourceLeadDays = 1;
        } else if (testAny(/모레(?:[(（][^)）]+[)）])?\s*(?:도착|배송)/)) {
          sourceLeadDays = 1;
        } else {
            const within = matchAny(/(\d{1,2})\s*일\s*(?:이내|이내에)\s*(도착|배송|발송|출고)/);
            const range = matchAny(/(\d{1,2})\s*[-~～]\s*(\d{1,2})\s*일/);
            const singular = matchAny(/출고(?:\s*소요)?\s*(\d{1,2})\s*일/);
          if (within) sourceLeadDays = normalizeSourceLeadDays(parseInt(within[1], 10), within[2]);
          else if (range) sourceLeadDays = parseInt(range[2], 10);
          else if (singular) sourceLeadDays = parseInt(singular[1], 10);
          else {
            // 2026-04-21 v1.2.1 ~ 22 v1.2.2: "4/24(금) 도착 예정" / "04.24 도착 예정" 절대 날짜.
            //   사용자 스크린샷에서 SSG "배송일 4/24(금) 도착 예정" 표기 확인.
            //   v1.2.2 에서는 hydrated JSON 까지 스캔해 async 렌더 전에도 잡음.
            const absDate = matchAny(/(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(도착|배송|발송|출고)/);
            if (absDate) {
              const mm = parseInt(absDate[1], 10);
              const dd = parseInt(absDate[2], 10);
              if (Number.isFinite(mm) && Number.isFinite(dd) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
                const bizDiff = businessDaysUntilMonthDay(mm, dd);
                sourceLeadDays = normalizeSourceLeadDays(bizDiff, absDate[3]);
              }
            }
          }
        }
        if (sourceLeadDays != null && (!Number.isFinite(sourceLeadDays) || sourceLeadDays < 1 || sourceLeadDays > 30)) {
          sourceLeadDays = null;
        }

        const dedupedOptions = [...options.reduce((map, option) => {
          const key = cleanSsgOptionTextLocal(option?.optionName);
          if (!key) return map;
          const previous = map.get(key);
          if (previous) {
            previous.stock = Number(previous.stock || 0) + Number(option.stock || 0);
            previous.isSoldout = Boolean(previous.isSoldout) && Boolean(option.isSoldout);
          } else {
            map.set(key, { ...option, optionName: key });
          }
          return map;
        }, new Map()).values()];

        const hasSingleStockSignal = /(?:displInvQty|usablInvQty)['"]?\s*[:=]\s*['"]?\d+/.test(html);
        const optionsReliable = dedupedOptions.length > 0 || hasSingleStockSignal || productData.soldOut === 'Y';

        return { options: dedupedOptions, images, productData, specs, categorySource, sourceLeadDays, cardBenefitPrice: cardPrice, cardBenefitDetails: cardDetails.length > 0 ? cardDetails : null, productNotices: productNotices.length > 0 ? productNotices : null, optionsReliable };
      },
    });

    return result.result || null;
  } catch (e) {
    console.warn('[SSG] executeScript 실패:', e.message);
    _ssgTabId = null;
    return null;
  }
}

/**
 * 목적: SSG 상품 상세 HTML에서 카드 혜택가 정보 파싱
 * - 최저 카드혜택가 및 카드별 상세 금액 추출
 */
function parseCardBenefit(html) {
  // 최저 카드혜택가: .mndtl_card_price → ssg_price 클래스 내 금액
  const cardPriceMatch = html.match(/mndtl_card_price[\s\S]*?ssg_price">\s*([\d,]+)\s*<\/em>/);
  const cardPrice = cardPriceMatch ? parseInt(cardPriceMatch[1].replace(/,/g, ''), 10) : null;

  // 카드별 상세: 개별 <dl> 블록 단위로 파싱 (greedy 방지)
  const cardDetails = [];
  // 각 카드 혜택 블록: <dl class="cdtl_card_dl">...<dt>카드명</dt>...<dd>...<em>금액</em>...</dd>...</dl>
  const blockRegex = /<dl[^>]*class="[^"]*cdtl_card_dl[^"]*"[^>]*>([\s\S]*?)<\/dl>/g;
  let bm;
  while ((bm = blockRegex.exec(html)) !== null) {
    const block = bm[1];
    const nameMatch = block.match(/<dt[^>]*>([\s\S]*?)<\/dt>/);
    const priceMatch = block.match(/ssg_price">\s*([\d,]+)\s*<\/em>/);
    if (nameMatch && priceMatch) {
      const price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
      // 가격 유효성 검증: 10,000 ~ 10,000,000 범위만
      if (price >= 1000 && price <= 10000000) {
        cardDetails.push({
          card: nameMatch[1].replace(/<[^>]+>/g, '').trim(),
          price,
        });
      }
    }
  }

  return { cardPrice, cardDetails };
}

/** 상품 상세 조회 — API fetch(쿠키 수동 주입) 우선, 실패 시 Content Script fallback */
export async function fetchDetail(itemId, siteNo = '6009', useContentScript = false) {
  try {
    const url = `${DETAIL_BASE}?itemId=${itemId}&siteNo=${siteNo}`;
    await waitSsgDetailSlot(useContentScript);

    // API fetch 우선 (쿠키 수동 주입으로 로그인 상태 유지)
    const headers = await getSsgHeaders();
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (isSsgBlockedHtml(html)) {
      markSsgDetailBlocked('captcha/html challenge');
      throw new Error('SSG detail captcha/html block');
    }

    // resultItemObj 파싱
    let productData = {};
    const itemMatch = html.match(/var\s+resultItemObj\s*=\s*\{([\s\S]*?)\};/);
    if (itemMatch) {
      try {
        productData = JSON.parse('{' + itemMatch[1]
          .replace(/'/g, '"')
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/(\w+)\s*:/g, '"$1":')
          + '}');
      } catch {
        // 정규식 fallback
        const extract = (key) => {
          const m = itemMatch[1].match(new RegExp(`${key}\\s*:\\s*['"]([^'"]*)`));
          return m ? m[1] : '';
        };
        const extractNum = (key) => {
          const m = itemMatch[1].match(new RegExp(`${key}\\s*:\\s*(?:parseInt\\()?['\"]?(\\d+)`));
          return m ? parseInt(m[1], 10) : 0;
        };
        productData = {
          itemNm: extract('itemNm'),
          brandNm: extract('brandNm'),
          sellprc: extractNum('sellprc'),
          bestAmt: extractNum('bestAmt'),
          soldOut: extract('soldOut'),
        };
      }
    }

    // uitemObj = {...} 패턴 파싱 (옵션/사이즈)
    // SSG는 uitemObjArr.push({...})가 아니라 uitemObj = {...}; 형태
    const options = [];
    let rawOptionObjectCount = 0;
    const optionMatches = html.matchAll(/uitemObj\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g);
    for (const m of optionMatches) {
      try {
        rawOptionObjectCount++;
        const optStr = m[1];
        const get = (key) => {
          const match = optStr.match(new RegExp(key + "\\s*:\\s*'([^']*)"));
          return match ? match[1] : '';
        };
        const getNum = (key) => {
          const match = optStr.match(new RegExp(key + "\\s*:\\s*'?(\\d+)"));
          return match ? parseInt(match[1], 10) : 0;
        };

        const optName = pickSsgOptionName(get, productData.itemNm || '');
        const optType = get('uitemOptnTypeNm1') || '';

        // '대표단품'은 스킵 (옵션이 아님)
        if (!optName || optName === '대표단품') continue;

        const stock = getNum('usablInvQty');
        const soldOut = get('soldOutYn') === 'Y' || stock === 0;

        options.push({
          optionName: optName,
          optionType: optType || 'size',
          optionGroupIndex: 0,
          parentId: null,
          sku: get('uitemId') || '',
          stock,
          isSoldout: soldOut,
          priceDiff: getNum('addPrc') || 0,
        });
      } catch { /* skip malformed option */ }
    }

    // 이미지 — CDN 패턴으로 생성
    const images = [];
    // HTML에서 이미지 URL 추출
    const imgMatches = html.matchAll(/https?:\/\/sitem\.ssgcdn\.com[^\s"']+_i\d+_\d+\.(?:jpg|png|webp)/gi);
    const seen = new Set();
    for (const im of imgMatches) {
      // 500px 버전으로 통일
      const normalized = im[0].replace(/_i(\d+)_\d+\./, '_i$1_500.');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        images.push(normalized);
      }
    }
    // fallback: itemId 기반 CDN URL 생성
    if (images.length === 0) {
      images.push(`https://sitem.ssgcdn.com/item/${itemId}_i1_500.jpg`);
    }

    // 목적: 카드 혜택가 파싱 (최저 카드혜택가 + 카드별 상세)
    const { cardPrice, cardDetails } = parseCardBenefit(html);
    const hasSingleStockSignal = /(?:displInvQty|usablInvQty)['"]?\s*[:=]\s*['"]?\d+/.test(html);
    let optionsReliable = rawOptionObjectCount > 0 || hasSingleStockSignal || productData.soldOut === 'Y';

    // 상품필수정보 파싱
    const productNotices = [];
    const specTable = html.match(/상품필수정보[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
    if (specTable) {
      const rowRegex = /<th[^>]*>\s*(?:<div[^>]*>)?([\s\S]*?)(?:<\/div>)?\s*<\/th>\s*<td>\s*(?:<div[^>]*>)?([\s\S]*?)(?:<\/div>)?\s*<\/td>/g;
      let rm;
      while ((rm = rowRegex.exec(specTable[1])) !== null) {
        const k = rm[1].replace(/<[^>]+>/g, '').trim();
        const v = rm[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();
        if (k && v) productNotices.push({ key: k, value: v });
      }
    }

    // specs 추출 (소재/색상/핏/계절)
    const specs = extractSpecsFromNotices(productNotices);

    // categorySource 추출 — 상세 HTML에서 breadcrumb 파싱 (search API의 stdCtgNm 보완)
    let categorySourceFromDetail = '';
    try {
      // 방법 1: gnb_ctg 또는 breadcrumb 형태의 텍스트 (SSG HTML 패턴)
      const breadcrumbMatch = html.match(/class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)
        || html.match(/class="[^"]*gnb_ctg[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      if (breadcrumbMatch) {
        const crumbs = breadcrumbMatch[1].match(/>([^<>]+)</g);
        if (crumbs) {
          const parts = crumbs.map(c => c.replace(/[<>]/g, '').trim()).filter(c => c && c !== '홈' && c.length > 1);
          if (parts.length > 0) categorySourceFromDetail = parts.join(' > ');
        }
      }
      // 방법 2: resultItemObj의 stdCtgNm 필드 파싱
      if (!categorySourceFromDetail) {
        const ctgMatch = html.match(/stdCtgNm\s*:\s*['"]([^'"]+)['"]/);
        if (ctgMatch) categorySourceFromDetail = ctgMatch[1];
      }
    } catch { /* categorySource 추출 실패 무시 */ }

    // 상세 이미지 추출 (iframe URL에서)
    let detailImages = [];
    let sizeGuideImages = [];
    try {
      const iframeMatch = html.match(/iframePItemDtlDesc\.ssg\?itemId=([^&"']+)[^"']*/);
      if (iframeMatch) {
        const descUrl = `https://itemdesc.ssg.com/item/iframePItemDtlDesc.ssg?itemId=${itemId}&dispSiteNo=${siteNo}`;
        const descRes = await fetch(descUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        if (descRes.ok) {
          const descHtml = await descRes.text();
          const media = extractSsgDetailMedia(descHtml);
          detailImages = media.detailImages;
          sizeGuideImages = media.sizeGuideImages;
        }
      }
    } catch { /* 상세이미지 실패 무시 */ }

    // specs 보강: 상품필수정보에서 추가 추출 (위에서 extractSpecsFromNotices로 기본 추출됨)
    const SPEC_KEYS = ['소재', '재질', '혼용률', '색상', '사이즈', '핏', '계절', '시즌', '제조국', '원산지', '제조자', '제조사', '품번', '모델번호', '성별'];
    for (const notice of productNotices) {
      const key = (notice.key || '').trim();
      const val = (notice.value || '').trim();
      if (!key || !val || val === '상세페이지 참조' || val === '상세설명참조' || val === '해당없음' || val === '해당사항 없음') continue;
      const matchedKey = SPEC_KEYS.find(sk => key.includes(sk));
      if (matchedKey) {
        const normalized = key.includes('재질') ? '소재' : key.includes('원산지') ? '제조국' : key.includes('시즌') ? '계절' : matchedKey;
        if (!specs[normalized]) specs[normalized] = val;
      }
    }

    // categorySource: HTML에서 카테고리 breadcrumb 추출 (검색 API stdCtgNm이 비어있을 때 보강)
    let categorySource = '';
    const breadcrumbMatch = html.match(/location_bx[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
    if (breadcrumbMatch) {
      const crumbs = [];
      const liRegex = /<li[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g;
      let lm;
      while ((lm = liRegex.exec(breadcrumbMatch[1])) !== null) {
        const text = lm[1].replace(/<[^>]+>/g, '').trim();
        if (text && text !== 'HOME' && text !== '홈') crumbs.push(text);
      }
      if (crumbs.length > 0) categorySource = crumbs.join(' > ');
    }

    const result = {
      options: dedupeSsgOptions(options),
      images,
      productData,
      // SSG 상세페이지 원문 이미지 영역은 차단/누락이 잦다.
      // 마켓 상세설명은 썸네일 갤러리를 기준으로 생성하도록 고정한다.
      detailImages: images,
      sizeGuideImages,
      specs,
      categorySource,
      cardBenefitPrice: cardPrice,
      cardBenefitDetails: cardDetails.length > 0 ? cardDetails : null,
      productNotices: productNotices.length > 0 ? productNotices : null,
      specs: Object.keys(specs).length > 0 ? specs : null,
      categorySourceFromDetail: categorySourceFromDetail || null,
      optionsReliable,
    };

    // API fetch 결과 검증 — 옵션/혜택가 없을 때만 탭 폴백.
    // 2026-06-12: 탭 폴백은 useContentScript(=수집 시 혜택가 명시 수집)일 때만 허용.
    //   업데이트 경로(useContentScript=false)는 windowless 전용 — 창/탭 팝업 없음.
    //   부족하면 아래 result(optionsReliable=false 가능)를 반환 → 잘못된 가격/재고는 푸시 안 됨.
    if (options.length === 0 && !cardPrice && useContentScript) {
      console.warn(`[SSG] API fetch 결과 불충분 (opts:0, card:null) → Content Script fallback`);
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
        try {
          const tabResult = await fetchDetailViaTab(url);
          if (hasUsableSsgDetail(tabResult)) {
            tabResult.optionsReliable = tabResult.optionsReliable !== false;
            markSsgDetailSuccess();
            return tabResult;
          }
        } catch (e) {
          console.warn('[SSG] Content Script fallback 실패:', e.message);
        }
      }
    }

    if (hasUsableSsgDetail(result) || result.optionsReliable !== false) {
      markSsgDetailSuccess();
    }
    return result;
  } catch (err) {
    console.warn(`[SSG] 상세 조회 실패 ${itemId}:`, err.message);
    // 최후 fallback: Content Script — windowless 업데이트 경로(useContentScript=false)에선 생략(창 안 뜸).
    if (useContentScript && typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
      try {
        const url = `${DETAIL_BASE}?itemId=${itemId}&siteNo=${siteNo}`;
        const tabResult = await fetchDetailViaTab(url);
        if (hasUsableSsgDetail(tabResult)) {
          tabResult.optionsReliable = tabResult.optionsReliable !== false;
          markSsgDetailSuccess();
          return tabResult;
        }
        if (tabResult?.detailFetchBlocked) {
          markSsgDetailBlocked(tabResult.blockReason || 'content script block');
        }
      } catch {}
    }
    return {
      options: [],
      optionsReliable: false,
      detailFetchBlocked: true,
      blockReason: err?.message || 'SSG detail fetch failed',
    };
  }
}

/** 배치 상세 조회 (동시성 제한) */
async function fetchDetailsBatch(items, onProgress, useContentScript = false) {
  const results = new Map();
  let completed = 0;

  async function processItem(item) {
    const detail = await fetchDetail(item.sourceId, item._siteNo, useContentScript);
    completed++;
    if (onProgress) onProgress(completed, items.length);

    if (detail) {
      results.set(item.sourceId, detail);
    }
    // API 부하 방지
  }

  // API fetch 우선 (빠름), Content Script fallback 시에만 순차
  const concurrency = CONCURRENCY;
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await processItem(item);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── 메인 수집 함수 ──────────────────────────────────────────────────────────

/**
 * SSG 수집 실행
 * @param {Object} params
 * @param {string} params.keyword - 검색 키워드
 * @param {string} params.searchUrl - 직접 URL (keyword 대신)
 * @param {number} params.limit - 최대 수집 수
 * @param {number} params.pageFrom - 시작 페이지
 * @param {number} params.pageTo - 끝 페이지
 * @param {Function} params.onProgress - 진행 콜백
 * @param {Function} params.onBatch - 배치 전송 콜백
 * @param {AbortSignal} params.signal - 중단 시그널
 * @returns {Promise<{collected: number, errors: number}>}
 */
/**
 * background.js 호환 래퍼
 * @param {string} urlOrKeyword - 검색 URL 또는 키워드
 * @param {number} limit - 최대 수집 수
 * @param {Function} progressCb - (progress%, found, collected, message)
 * @returns {Promise<Array>} 수집된 상품 배열
 */
export async function collect(urlOrKeyword, limit = 10000, progressCb, options = {}) {
  const allProducts = [];

  const result = await collectSSG({
    keyword: urlOrKeyword.startsWith('http') ? '' : urlOrKeyword,
    searchUrl: urlOrKeyword.startsWith('http') ? urlOrKeyword : '',
    limit,
    collectBenefit: !!options.collectBenefit,
    onProgress: ({ phase, page, totalPages, found, totalCount, done, total }) => {
      if (phase === 'search' && progressCb) {
        const pct = totalPages > 0 ? Math.round((page / totalPages) * 50) : 0;
        progressCb(pct, found, allProducts.length, `검색 ${page}/${totalPages}`);
      }
      if (phase === 'detail' && progressCb) {
        const pct = 50 + Math.round((done / total) * 50);
        progressCb(pct, total, allProducts.length, `상세 ${done}/${total}`);
      }
    },
    onBatch: async (batch) => {
      allProducts.push(...batch);
      // 스트리밍 전송: background.js에서 전달한 onBatch로 즉시 서버 전송
      if (options.onBatch) {
        try { await options.onBatch(batch); } catch (e) { console.error('[SSG] 스트리밍 전송 실패:', e.message); }
      }
    },
  });

  if (progressCb) progressCb(100, allProducts.length, allProducts.length, '완료');
  return allProducts;
}

export async function collectSSG({
  keyword,
  searchUrl,
  limit = 0,
  pageFrom = 1,
  pageTo = 0,
  collectBenefit = false,
  onProgress,
  onBatch,
  signal,
} = {}) {
  const parsedSearch = parseSearchUrl(searchUrl);
  const effectiveFilters = parsedSearch.filters;
  if (!keyword && parsedSearch.keyword) keyword = parsedSearch.keyword;

  if (!keyword) throw new Error('검색 키워드가 필요합니다');

  const allowedBrands = effectiveFilters.repBrandId
    ? await resolveAllowedBrands(searchUrl, effectiveFilters)
    : [];

  console.log(
    `[SSG] 수집 시작: "${keyword}" (limit: ${limit || '무제한'}, filters: ${JSON.stringify(effectiveFilters)}, allowedBrands: ${JSON.stringify(allowedBrands)})`
  );

  let collected = 0;
  let errors = 0;
  let page = pageFrom;
  const allItems = [];

  // 1단계: 검색 API로 상품 목록 수집
  while (true) {
    if (signal?.aborted) break;

    try {
      const data = await fetchSearchPage(keyword, page, effectiveFilters);
      const { items, totalPages, totalCount } = parseSearchResults(data);
      const { allowed: filteredItems, rejected } = partitionByAllowedBrands(items, allowedBrands);

      if (page === pageFrom) {
        console.log(`[SSG] 총 ${totalCount}개 상품, ${totalPages} 페이지`);
      }

      if (items.length === 0) {
        console.log(`[SSG] 페이지 ${page}: 결과 없음 → 종료`);
        break;
      }

      if (rejected.length > 0) {
        const rejectedBrands = [...new Set(rejected.map((item) => item.brand).filter(Boolean))];
        console.warn(`[SSG] 페이지 ${page}: 허용되지 않은 브랜드 ${rejected.length}개 제외`, rejectedBrands);
      }

      // 기획전(deal) 상품 수집차단 — salestrNo 있는 항목은 dealItemView 로만 판매돼 itemView
      // 업데이트 불가(업데이트 시 창 팝업 유발) → 애초에 수집하지 않는다.
      const dealItems = filteredItems.filter((item) => item._salestrNo);
      const collectableItems = filteredItems.filter((item) => !item._salestrNo);
      if (dealItems.length > 0) {
        console.warn(`[SSG] 페이지 ${page}: 기획전(deal) 상품 ${dealItems.length}개 수집 제외 (salestrNo)`);
      }

      console.log(`[SSG] 페이지 ${page}: ${collectableItems.length}개`);
      allItems.push(...collectableItems);

      if (onProgress) {
        onProgress({
          phase: 'search',
          page,
          totalPages,
          found: allItems.length,
          totalCount,
        });
      }

      // 종료 조건
      if (limit > 0 && allItems.length >= limit) {
        allItems.length = limit; // trim
        break;
      }
      if (pageTo > 0 && page >= pageTo) break;
      if (page >= totalPages) break;

      page++;
      await new Promise(r => setTimeout(r, 500)); // API 부하 방지
    } catch (err) {
      console.error(`[SSG] 페이지 ${page} 에러:`, err.message);
      errors++;
      if (errors > 5) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`[SSG] 검색 완료: ${allItems.length}개 수집`);

  // 2단계: 50개씩 상세 조회 + 즉시 서버 전송 (스트리밍)
  if (allItems.length > 0) {
    const useCS = !!collectBenefit;
    const STREAM_BATCH = 50;
    let detailDone = 0;
    const totalItems = allItems.length;
    console.log(`[SSG] 상세+전송 시작 (${totalItems}개, ${useCS ? 'Content Script' : 'API'}, ${STREAM_BATCH}개씩 스트리밍)`);

    for (let i = 0; i < totalItems; i += STREAM_BATCH) {
      if (signal?.aborted) break;
      const chunk = allItems.slice(i, i + STREAM_BATCH);

      // 상세 조회 (chunk 단위)
      const details = await fetchDetailsBatch(chunk, (done, total) => {
        const globalDone = detailDone + done;
        if (onProgress) {
          onProgress({ phase: 'detail', done: globalDone, total: totalItems });
        }
      }, useCS);
      detailDone += chunk.length;

      // 상세 데이터 병합
      for (const item of chunk) {
        const detail = details.get(item.sourceId);
        if (detail) {
          item.optionsReliable = detail.optionsReliable !== false;
          if (detail.detailFetchBlocked) {
            item.detailFetchBlocked = true;
            item.detailBlockReason = detail.blockReason || 'SSG detail fetch blocked';
          }
          if (detail.images?.length > 0) item.images = detail.images;
          if (detail.options?.length > 0) item.options = detail.options;
          if (detail.productData) {
            if (detail.productData.brandNm) item.brand = detail.productData.brandNm;
            if (detail.productData.bestAmt) item.sellPrice = detail.productData.bestAmt;
            if (detail.productData.sellprc) item.originalPrice = detail.productData.sellprc;
            // 옵션 없는 단일상품: soldOut 플래그 + 실제 재고로 품절 판정
            // SSG는 soldOut='N'이지만 usablInvQty=0인 일시품절 상태가 존재
            if (detail.productData.soldOut === 'Y') {
              item.isSoldout = true;
              item.totalStock = 0;
            } else if (detail.options?.length > 0) {
              // 옵션 있으면 옵션별 재고 합산으로 판정 (이미 options에 반영됨)
              const optStock = detail.options.reduce((s, o) => s + (o.stock || 0), 0);
              item.totalStock = Math.min(optStock, 10);
              item.isSoldout = detail.options.every(o => o.isSoldout);
            } else {
              // 옵션 없고 soldOut !== 'Y' → Search API totalStock으로 판정
              // totalStock=0이면 품절 (usablInvQty=0 케이스)
              if (item.isSoldout === true || item.totalStock === 0) {
                item.isSoldout = true;
                item.totalStock = 0;
              } else {
                item.isSoldout = false;
                if (!item.totalStock) {
                  item.totalStock = 10;
                  item.stockReliable = false;
                  item.ssgStockReliableV2 = false;
                }
              }
            }
          }
          // specs 병합 (상품필수정보에서 추출)
          if (detail.specs && Object.keys(detail.specs).length > 0) {
            item.specs = detail.specs;
          }
          // categorySource 보강 (검색 API stdCtgNm이 비어있을 때)
          if (detail.categorySource && (!item.categorySource || item.categorySource === '')) {
            item.categorySource = detail.categorySource;
          }
          if (detail.cardBenefitPrice != null) item.cardBenefitPrice = detail.cardBenefitPrice;
          if (detail.cardBenefitDetails != null) item.cardBenefitDetails = detail.cardBenefitDetails;
          if (detail.productNotices != null) item.productNotices = detail.productNotices;
          if (detail.images?.length > 0) item.detailImages = detail.images;
          else if (detail.detailImages != null) item.detailImages = detail.detailImages;
          if (detail.sizeGuideImages != null) item.sizeGuideImages = detail.sizeGuideImages;
          // specs (소재/색상/핏/계절)
          if (detail.specs != null) item.specs = detail.specs;
          // categorySource 보완 — search API에서 비어있는 경우 detail HTML에서 추출한 값으로 보완
          if (!item.categorySource && detail.categorySourceFromDetail) {
            item.categorySource = detail.categorySourceFromDetail;
          }
          // 배송비
          if (detail.productData) {
            const dlvCst = detail.productData.dlvCst || 0;
            const freeDlv = detail.productData.freeDlvYn === 'Y';
            item.shippingType = freeDlv ? 'free' : (dlvCst > 0 ? 'paid' : 'free');
            item.shippingFee = freeDlv ? 0 : dlvCst;
          }
          // 소싱처 배송 소요일 (Phase 2)
          if (detail.sourceLeadDays != null) {
            item.sourceLeadDays = detail.sourceLeadDays;
          }
        }
      }

      // 즉시 서버 전송 (_내부필드 제거)
      const { allowed: allowedChunk, rejected: rejectedChunk } = partitionByAllowedBrands(chunk, allowedBrands);

      if (rejectedChunk.length > 0) {
        const rejectedBrands = [...new Set(rejectedChunk.map((item) => item.brand).filter(Boolean))];
        console.warn(`[SSG] 상세 병합 후 제외 ${rejectedChunk.length}개`, rejectedBrands);
      }

      const cleanBatch = allowedChunk.map(item => {
        const { _siteNo, _salestrNo, ...clean } = item;
        return clean;
      });

      if (onBatch) {
        await onBatch(cleanBatch);
        collected += cleanBatch.length;
      }

      console.log(`[SSG] 스트리밍 전송: ${cleanBatch.length}개 (누적 ${collected}/${totalItems})`);
    }
  }

  console.log(`[SSG] 수집 완료: ${collected}개 저장, ${errors}개 에러`);
  return { collected, errors };
}
