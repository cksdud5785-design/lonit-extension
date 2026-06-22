/**
 * 로닛(Lonit) 업데이트 엔진 — 가격/재고 업데이트를 확장프로그램으로 이관
 *
 * 흐름:
 *  1. GET /update/pending → 업데이트 필요 상품 목록 (최대 50개)
 *  2. 소싱처별 상품 상세 파싱 (기존 musinsa.js / ssg.js / lotteon.js 함수 재사용)
 *  3. POST /update/receive → 서버에 전송 (배치 10개씩, 상품 간 1초 딜레이)
 *
 * 사용: background.js에서 chrome.alarms 'updateCheck'로 5분마다 호출
 *
 * v1.0.4 (2026-04-10): parseMusinsaDetail 이 musinsaRaw + 부가 혜택 필드 forward.
 *   이전엔 sellPrice/originalPrice/benefitPrice 만 보내서 backend resolveSellPrice 가
 *   musinsaRaw=undefined → salePrice 그대로 반환 → 업데이트 시 chain 미적용 버그.
 */

import { getDetail as getMusinsaDetail, getOptions as getMusinsaOptions } from './musinsa.js';
import {
  businessDaysUntilMonthDay as businessDaysUntilSsgMonthDay,
  fetchDetail as fetchSsgFullDetail,
  normalizeSourceLeadDays as normalizeSsgSourceLeadDays,
} from './ssg.js';
import { computeLotteonSourceLeadDays } from './lotteon-v1225.js';
import { apiCall } from './api.js';
import { MUSINSA_LOGIN_WARNING, syncAllCookies } from './source-account-sync.js';

console.log('[Lonit] updater.js v1.2.25 (trusted arrival lead + shipping fee sync)');

// ─── 상수 ──────────────────────────────────────────────────────────────────────
// v1.1.5 (2026-04-18): 시장별 독립 워커 병렬 처리 — 각 마켓 rate limit 독립.
//   이전 v1.1.4: 450 products × 3~5s (parseProduct 내부 N 개 순차 API call) = 20~35min/cycle
//   이후 v1.1.5: 3 워커 병렬 → 약 7~12min/cycle (3x speedup)
//   효과: musinsa 9200건 2h → ≈40min
// 안전성: 각 소싱 API 는 서로 다른 호스트/rate-limit. 동일 호스트 내부 순차 유지.
const BATCH_SIZE = 25;      // 한 번에 서버에 전송할 아이템 수
const ITEM_DELAY_MS = 150;  // 상품 간 딜레이 (마켓별 워커 내부) — 내부 randomDelay 가 rate limit 보장
const SSG_ITEM_DELAY_MIN_MS = 3000;
const SSG_ITEM_DELAY_START_MS = 4200;
const SSG_ITEM_DELAY_MAX_MS = 60_000;
const SSG_ITEM_JITTER_MS = 1800;
const SSG_ITEM_SPEED_UP_EVERY = 20;
const SSG_ITEM_BLOCK_COOLDOWN_MS = 10 * 60_000;
const MARKET_UPDATE_CONCURRENCY = { musinsa: 2, ssg: 1, lotteon: 3 };
const MAX_STOCK = 10;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const capStock = (n) => Math.min(Math.max(0, n ?? 0), MAX_STOCK);
const randomBetween = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));
let ssgUpdateDelayMs = SSG_ITEM_DELAY_START_MS;
let ssgUpdateSuccesses = 0;
let ssgUpdateBlockedUntil = 0;

function isSsgBlockedHtml(html = '') {
  const body = String(html || '');
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

async function waitSsgUpdateSlot() {
  const remainingCooldownMs = ssgUpdateBlockedUntil - Date.now();
  if (remainingCooldownMs > 0) {
    console.warn(`[Updater:SSG] 차단 쿨다운 대기 ${Math.ceil(remainingCooldownMs / 1000)}초`);
    await delay(remainingCooldownMs);
  }
  await delay(ssgUpdateDelayMs + randomBetween(0, SSG_ITEM_JITTER_MS));
}

function markSsgUpdateBlocked(reason = 'blocked') {
  ssgUpdateDelayMs = Math.min(SSG_ITEM_DELAY_MAX_MS, Math.max(SSG_ITEM_DELAY_MIN_MS, Math.floor(ssgUpdateDelayMs * 2)));
  ssgUpdateSuccesses = 0;
  ssgUpdateBlockedUntil = Date.now() + SSG_ITEM_BLOCK_COOLDOWN_MS;
  console.warn(`[Updater:SSG] 차단 감지: ${reason}. delay=${ssgUpdateDelayMs}ms, ${Math.round(SSG_ITEM_BLOCK_COOLDOWN_MS / 1000)}초 쿨다운`);
}

function markSsgUpdateSuccess() {
  ssgUpdateSuccesses++;
  if (ssgUpdateSuccesses < SSG_ITEM_SPEED_UP_EVERY) return;
  ssgUpdateSuccesses = 0;
  const nextDelay = Math.max(SSG_ITEM_DELAY_MIN_MS, Math.floor(ssgUpdateDelayMs * 0.9));
  if (nextDelay < ssgUpdateDelayMs) {
    console.log(`[Updater:SSG] 속도 증가: ${ssgUpdateDelayMs}ms → ${nextDelay}ms`);
    ssgUpdateDelayMs = nextDelay;
  }
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

function dedupeSsgUpdateOptions(options = []) {
  const byName = new Map();
  for (const option of options) {
    const key = cleanSsgOptionText(option?.name ?? option?.optionName);
    if (!key) continue;
    const previous = byName.get(key);
    if (!previous) {
      byName.set(key, { ...option, name: key });
      continue;
    }
    previous.stock = capStock(Number(previous.stock || 0) + Number(option.stock || 0));
    previous.isSoldout = Boolean(previous.isSoldout) && Boolean(option.isSoldout);
  }
  return [...byName.values()];
}

function extractSsgThumbnailImages(html, sourceId) {
  const images = [];
  const seen = new Set();
  const add = (url) => {
    const clean = String(url || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    images.push(clean);
  };

  for (const match of html.matchAll(/https?:\/\/sitem\.ssgcdn\.com[^\s"']+_i\d+_\d+\.(?:jpg|jpeg|png|webp)/gi)) {
    add(match[0].replace(/_i(\d+)_\d+\./, '_i$1_1000.'));
  }
  if (images.length === 0) {
    add(`https://sitem.ssgcdn.com/item/${sourceId}_i1_1000.jpg`);
  }
  return images.slice(0, 10);
}

async function fetchSsgSearchSnapshot(sourceId, sourceUrl) {
  const siteNoMatch = sourceUrl?.match(/siteNo=(\d+)/);
  const siteNo = siteNoMatch ? siteNoMatch[1] : '6009';
  const res = await fetch('https://search.ssg.com/api/item/all', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Referer': 'https://www.ssg.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      siteNo,
      query: String(sourceId),
      target: 'pc_item',
      count: '1',
      directYn: 'Y',
      page: 1,
      recomIndex: 0,
      aplTgtMediaCd: '10',
    }),
  });
  if (!res.ok) throw new Error(`SSG search HTTP ${res.status}`);
  const data = await res.json();
  const unit = data?.data?.dataList?.find((entry) => entry.unitType === 'ITEM_UNIT_LIST');
  const items = Array.isArray(unit?.dataList) ? unit.dataList : [];
  const item = items.find((entry) => String(entry.itemId) === String(sourceId));
  if (!item) throw new Error('SSG search item missing');

  const sellPrice = parseInt(item.displayPrc || '0', 10) || 0;
  const originalPrice = parseInt(item.strikeOutPrc || item.sellprc || item.displayPrc || '0', 10) || sellPrice;
  const rawQty = item.usablInvQty;
  const hasQty = rawQty !== undefined && rawQty !== null && rawQty !== '';
  const parsedQty = hasQty ? Number(rawQty) : null;
  const totalStock = Number.isFinite(parsedQty) ? Math.max(0, parsedQty) : null;
  const explicitSoldout = item.soldOutYn === 'Y' || item.stoppedSellingYn === 'Y';
  const thumbnail = String(item.itemImgUrl || '').trim();
  const optionMessage = String(item.msgWhenGoToItemDetailNew || '');
  const sourceHasOptions =
    /옵션/.test(optionMessage)
    || (String(item.goItemDetailYnNew || '') === 'Y' && String(item.uitemId || '') === '00000');
  return {
    sellPrice,
    originalPrice,
    couponPrice: sellPrice || null,
    benefitPrice: sellPrice || null,
    totalStock,
    rawTotalStock: totalStock,
    isSoldout: explicitSoldout || (totalStock != null && totalStock === 0),
    images: thumbnail ? [thumbnail] : [],
    detailImages: thumbnail ? [thumbnail] : [],
    options: [],
    stockReliable: hasQty || explicitSoldout,
    optionsReliable: false,
    sourceHasOptions,
    sourceSearchTitle: item.itemNm || '',
  };
}

// ─── SSG fetchDetail 래퍼 ─────────────────────────────────────────────────────
// ssg.js의 fetchDetail은 module-scoped function이라 import 불가 → 직접 호출
async function parseSsgDetail(sourceId, sourceUrl) {
  let searchSnapshot = null;
  const searchSnapshotPromise = fetchSsgSearchSnapshot(sourceId, sourceUrl).catch((err) => {
    console.warn(`[Updater] SSG Search API 실패 ${sourceId}:`, err.message);
    return null;
  });

  try {
    await waitSsgUpdateSlot();
    // siteNo는 sourceUrl에서 추출 (siteNo=6001 등)
    const siteNoMatch = sourceUrl?.match(/siteNo=(\d+)/);
    const siteNo = siteNoMatch ? siteNoMatch[1] : '6009';

    // SSG 쿠키 가져오기 (로컬 브라우저에서 직접)
    const headers = {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const cookies = await chrome.cookies.getAll({ domain: '.ssg.com' });
      if (cookies.length > 0) {
        headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    }

    const url = `https://www.ssg.com/item/itemView.ssg?itemId=${sourceId}&siteNo=${siteNo}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (isSsgBlockedHtml(html)) {
      throw new Error('SSG detail captcha/html block');
    }
    searchSnapshot = await searchSnapshotPromise;

    // ── 가격 파싱 ───────────────────────────────────────────────────────────────
    let sellPrice = 0, originalPrice = 0, cardBenefitPrice = null, itemName = '';

    // resultItemObj에서 sellprc, bestAmt 추출
    const itemMatch = html.match(/var\s+resultItemObj\s*=\s*\{([\s\S]*?)\};/);
    if (itemMatch) {
      const extractNum = (key) => {
        const m = itemMatch[1].match(new RegExp(`${key}\\s*:\\s*(?:parseInt\\()?['"]?(\\d+)`));
        return m ? parseInt(m[1], 10) : 0;
      };
      const extractStr = (key) => {
        const m = itemMatch[1].match(new RegExp(`${key}\\s*:\\s*['"]([^'"]*)`));
        return m ? m[1] : '';
      };
      // bestAmt = 즉시할인가 (매입가), sellprc = 정가
      sellPrice = extractNum('bestAmt') || extractNum('sellprc') || extractNum('lwst_sellprc');
      originalPrice = extractNum('sellprc') || extractNum('normalPrc') || sellPrice;
      itemName = extractStr('itemNm');

      // 품절 상태
      const soldOutStr = extractStr('soldOut');
      if (soldOutStr === 'Y') return {
        sellPrice,
        originalPrice,
        couponPrice: sellPrice,
        cardBenefitPrice,
        totalStock: 0,
        isSoldout: true,
        options: [],
        shippingFee: 0,
        shippingType: 'free',
        stockReliable: true,
        optionsReliable: searchSnapshot?.sourceHasOptions !== true,
        sourceHasOptions: searchSnapshot?.sourceHasOptions === true,
        sourceSearchTitle: itemName || searchSnapshot?.sourceSearchTitle || '',
        detailFetchBlocked: false,
      };
    }
    if (!itemMatch || !sellPrice) {
      throw new Error('SSG detail product payload missing');
    }

    // ── 옵션/재고 파싱 ──────────────────────────────────────────────────────────
    const options = [];
    let totalStock = 0;
    let isSoldout = false;
    const optionMatches = html.matchAll(/uitemObj\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g);
    for (const m of optionMatches) {
      try {
        const optStr = m[1];
        const get = (key) => {
          const match = optStr.match(new RegExp(key + "\\s*:\\s*'([^']*)"));
          return match ? match[1] : '';
        };
        const getNum = (key) => {
          const match = optStr.match(new RegExp(key + "\\s*:\\s*(?:parseInt\\()?['\"]?(\\d+)"));
          return match ? parseInt(match[1], 10) : 0;
        };
        const optName = pickSsgOptionName(get, itemName);
        if (!optName || optName === '대표단품') continue;

        // 상품명과 같으면 대표단품 (단일 상품)
        // sellprc가 있으면 단일 상품 처리
        const stock = getNum('usablInvQty');
        const soldOut = get('soldOutYn') === 'Y' || stock === 0;
        totalStock += capStock(stock);
        if (!soldOut) isSoldout = false;

        options.push({
          name: optName,
          optionType: get('uitemOptnTypeNm1') || 'size',
          sku: get('uitemId') || '',
          stock: capStock(stock),
          isSoldout: soldOut,
        });
      } catch { /* skip */ }
    }

    const thumbnailImages = extractSsgThumbnailImages(html, sourceId);

    // 단일상품 (옵션 없음): soldOut 플래그 + displInvQty 실제 재고로 판정
    // SSG는 soldOut='N'이지만 usablInvQty=0인 일시품절 상태가 존재
    let rawTotalStock = 0;
    let singleStock = null;
    let explicitSoldout = false;
    let stockFromDetail = false;
    let normalizedOptions = dedupeSsgUpdateOptions(options);
    if (normalizedOptions.length === 0 && searchSnapshot?.sourceHasOptions === true) {
      try {
        console.warn(`[Updater] SSG 옵션 파싱 보강 fallback ${sourceId}`);
        const fallbackDetail = await fetchSsgFullDetail(sourceId, siteNo, true);
        const fallbackOptions = dedupeSsgUpdateOptions(fallbackDetail?.options ?? []);
        if (fallbackOptions.length > 0) {
          normalizedOptions = fallbackOptions.map((option) => ({
            name: option.name ?? option.optionName,
            optionType: option.optionType ?? 'size',
            sku: option.sku ?? '',
            stock: capStock(option.stock ?? 0),
            isSoldout: option.isSoldout ?? ((option.stock ?? 0) === 0),
            priceDiff: option.priceDiff ?? 0,
          }));
        }
      } catch (fallbackErr) {
        console.warn(`[Updater] SSG 옵션 fallback 실패 ${sourceId}:`, fallbackErr?.message || fallbackErr);
      }
    }
    if (normalizedOptions.length === 0) {
      const soldOutMatch = html.match(/soldOut\s*:\s*'([YN])'/);
      const invMatch = html.match(/(?:displInvQty|usablInvQty)['"]\s*:\s*['"]?(\d+)/);
      singleStock = invMatch ? parseInt(invMatch[1], 10) : null;
      explicitSoldout = Boolean(soldOutMatch && soldOutMatch[1] === 'Y');
      stockFromDetail = singleStock != null || explicitSoldout;
      const searchStock = searchSnapshot?.totalStock;
      rawTotalStock = singleStock ?? searchStock ?? 0;
      if (singleStock != null) {
        isSoldout = explicitSoldout || singleStock === 0;
        totalStock = isSoldout ? 0 : Math.min(singleStock, MAX_STOCK);
      } else if (searchSnapshot?.stockReliable === true) {
        isSoldout = explicitSoldout || searchSnapshot.isSoldout === true || searchStock === 0;
        totalStock = isSoldout ? 0 : Math.min(searchStock ?? 0, MAX_STOCK);
      } else {
        isSoldout = explicitSoldout === true;
        totalStock = isSoldout ? 0 : 0;
      }
    } else {
      rawTotalStock = normalizedOptions.reduce((sum, opt) => sum + Math.max(0, Number(opt.stock ?? 0)), 0);
      totalStock = normalizedOptions.reduce((sum, opt) => sum + capStock(opt.stock), 0);
      isSoldout = normalizedOptions.every((opt) => opt.isSoldout);
      isSoldout = totalStock === 0;
      totalStock = Math.min(totalStock, MAX_STOCK);
    }

    // 카드혜택가: HTML 카드 섹션에서 추출
    const cardMatch = html.match(/mndtl_card_price[\s\S]*?ssg_price">\s*([\d,]+)\s*<\/em>/);
    cardBenefitPrice = cardMatch ? parseInt(cardMatch[1].replace(/,/g, ''), 10) : null;

    // 배송비 파싱
    const freeDlvMatch = html.match(/freeDlvMnAmt\s*:\s*'?(\d+)/);
    const dlvCstMatch = html.match(/dlvCst\s*:\s*'?(\d+)/);
    const dlvTextMatch = html.match(/(?:배송비|택배비)[^\d]{0,30}([\d,]+)\s*원/);
    const freeDlvMinAmt = freeDlvMatch ? parseInt(freeDlvMatch[1], 10) : 0;
    const textDlvCst = dlvTextMatch ? parseInt(dlvTextMatch[1].replace(/,/g, ''), 10) : 0;
    const dlvCst = dlvCstMatch ? parseInt(dlvCstMatch[1], 10) : textDlvCst;
    const freeByText = /무료배송|배송비\s*무료|택배배송\s*무료/.test(html);
    const freeDlv = freeByText || (freeDlvMinAmt > 0 ? sellPrice >= freeDlvMinAmt : dlvCst === 0);
    const shippingType = freeDlv ? 'free' : (dlvCst > 0 ? 'paid' : 'free');
    const shippingFee = freeDlv ? 0 : dlvCst;

    // 2026-04-22 PR-D: SSG 실시간 동기화 sourceLeadDays — HTML 전체에서 "M/D 도착" regex.
    //   ssg.js v1.2.2 (DOM 기반) 와 동일 절대날짜 패턴. 내일/모레/M.D 도착 확인.
    let sourceLeadDays = null;
    try {
      if (/내일(?:[(（][^)）]+[)）])?\s*(?:도착|배송)/.test(html)) sourceLeadDays = 1;
      else if (/모레(?:[(（][^)）]+[)）])?\s*(?:도착|배송)/.test(html)) sourceLeadDays = 1;
      else {
        const within = html.match(/(\d{1,2})\s*일\s*(?:이내|이내에)\s*(도착|배송|발송|출고)/);
        const singular = html.match(/출고(?:\s*소요)?\s*(\d{1,2})\s*일/);
        if (within) sourceLeadDays = normalizeSsgSourceLeadDays(parseInt(within[1], 10), within[2]);
        else if (singular) sourceLeadDays = parseInt(singular[1], 10);
        else {
          const absDate = html.match(/(\d{1,2})\s*[./]\s*(\d{1,2})(?:\s*\([^)]+\))?\s*(?:이내\s*)?(도착(?:확률|예정)?|배송|발송|출고)/);
          if (absDate) {
            const mm = parseInt(absDate[1], 10);
            const dd = parseInt(absDate[2], 10);
            if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
              const bizDiff = businessDaysUntilSsgMonthDay(mm, dd);
              sourceLeadDays = normalizeSsgSourceLeadDays(bizDiff, absDate[3]);
            }
          }
        }
      }
      if (sourceLeadDays != null && (!Number.isFinite(sourceLeadDays) || sourceLeadDays < 1 || sourceLeadDays > 30)) {
        sourceLeadDays = null;
      }
    } catch { /* null fallback */ }

    const sourceHasOptions = normalizedOptions.length > 0 || searchSnapshot?.sourceHasOptions === true;
    const optionsReliable = !(sourceHasOptions && normalizedOptions.length === 0);

    markSsgUpdateSuccess();
    return {
      sellPrice,
      originalPrice,
      couponPrice: sellPrice,
      cardBenefitPrice,
      totalStock,
      rawTotalStock,
      isSoldout,
      options: normalizedOptions,
      images: thumbnailImages,
      detailImages: thumbnailImages,
      shippingFee,
      shippingType,
      shippingFeeReliable: true,
      priceReliable: true,
      sourceLeadDays,
      sourceLeadDaysReliable: sourceLeadDays != null,
      arrivalLeadDaysV2: sourceLeadDays != null,
      stockReliable: normalizedOptions.length > 0 || stockFromDetail,
      ssgStockReliableV2: normalizedOptions.length > 0 || stockFromDetail,
      ssgDetailParsedV2: true,
      ssgDetailStockReliableV2: normalizedOptions.length > 0 || stockFromDetail,
      optionsReliable,
      sourceHasOptions,
      sourceSearchTitle: itemName || searchSnapshot?.sourceSearchTitle || '',
      detailFetchBlocked: false,
    };
  } catch (err) {
    searchSnapshot = searchSnapshot ?? await searchSnapshotPromise;
    if (/SSG detail captcha|HTTP 403|HTTP 429|payload missing/i.test(err?.message || '')) {
      markSsgUpdateBlocked(err.message);
    }
    console.warn(`[Updater] SSG 파싱 실패 ${sourceId}:`, err.message);
    if (searchSnapshot) {
      return {
        ...searchSnapshot,
        stockReliable: false,
        ssgStockReliableV2: false,
        ssgDetailParsedV2: false,
        ssgDetailStockReliableV2: false,
        optionsReliable: false,
        detailFetchBlocked: true,
      };
    }
    return null;
  }
}

// ─── 롯데ON fetchDetail 래퍼 ──────────────────────────────────────────────────
async function parseLotteonDetail(sourceId, sourceUrl) {
  try {
    const pdId = sourceId;
    // mall_no: sourceUrl에서 추출 (롯데백화점=2 등), 없으면 기본 1
    const mallMatch = sourceUrl?.match(/mall_no=(\d+)/);
    const mallNo = mallMatch ? mallMatch[1] : '1';

    // pbf API: base 정보 조회
    const baseUrl = `https://pbf.lotteon.com/product/v2/detail/search/base/pd/${pdId}?mall_no=${mallNo}&isNotContainOptMapping=true`;
    const baseRes = await fetch(baseUrl, { headers: { 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' } });
    if (!baseRes.ok) throw new Error(`pbf base HTTP ${baseRes.status}`);
    const baseData = await baseRes.json();

    // basicInfo에서 spdNo, sitmNo 추출 (백엔드 lotteon-api.ts와 동일 경로)
    const info = baseData?.data?.basicInfo || {};
    const spdNo = info.spdNo;
    const sitmNo = info.sitmNo;
    const trNo = info.trNo || '';
    const trGrpCd = info.trGrpCd || '';
    const lrtrNo = info.lrtrNo || '';

    // 정가 (slPrc = list price)
    const priceInfo = baseData?.data?.priceInfo || {};
    const listPrice = priceInfo.slPrc || priceInfo.displayPrc || priceInfo.selPrc || 0;

    // promotion API로 실제 할인가 조회 (slPrc는 정가이므로 promotion이 실제 판매가)
    let sellPrice = listPrice;
    if (spdNo && sitmNo) {
      try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const aplyStdDttm = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const promoBody = {
          spdNo, sitmNo, trGrpCd, trNo, lrtrNo: lrtrNo || '',
          strCd: info.strCd || null, ctrtTypCd: info.ctrtTypCd,
          slPrc: listPrice, slQty: 1,
          scatNo: info.scatNo || '', brdNo: info.brdNo || '',
          sfcoPdMrgnRt: priceInfo.sfcoPdMrgnRt ?? null,
          sfcoPdLwstMrgnRt: priceInfo.sfcoPdLwstMrgnRt ?? null,
          afflPdMrgnRt: priceInfo.afflMrgnRt ?? null,
          aplyStdDttm, mallNo,
        };
        const promoRes = await fetch('https://pbf.lotteon.com/product/v2/extlmsa/promotion/qtyChangeFavorInfoList', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' },
          body: JSON.stringify(promoBody),
        });
        if (promoRes.ok) {
          const promoData = await promoRes.json();
          const pi = promoData?.data?.priceInfo || {};
          const promoPrice = pi.immdDcAplyTotAmt || pi.orderDcAplyTotAmt;
          if (promoPrice && promoPrice > 0) sellPrice = promoPrice;
        }
      } catch { /* promotion API 실패 → listPrice fallback */ }
    }

    // 옵션 매핑
    const options = [];
    let totalStock = 0;
    let isSoldout = false;

    if (spdNo && sitmNo) {
      try {
        const optUrl = `https://pbf.lotteon.com/product/v2/detail/option/mapping/${spdNo}/${sitmNo}?trNo=${trNo}&trGrpCd=${trGrpCd}&lrtrNo=${lrtrNo}&pdNo=${pdId}`;
        const optRes = await fetch(optUrl, { headers: { 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' } });
        if (optRes.ok) {
          const optData = await optRes.json();
          const optionGroups = optData?.data?.optionInfo?.optionList ?? [];
          const mapping = optData?.data?.optionInfo?.optionMappingInfo ?? {};

          if (optionGroups.length > 1) {
            const parentGroup = optionGroups[0] || {};
            const childGroup = optionGroups[1] || {};
            for (const parentOpt of (parentGroup.options || [])) {
              const parentSku = String(parentOpt.value || parentOpt.label || '');
              const parentSold = !!parentOpt.disabled;
              options.push({
                name: parentOpt.label || parentOpt.value || '',
                optionType: parentGroup.title || 'option1',
                sku: parentSku,
                stock: parentSold ? 0 : 10,
                isSoldout: parentSold,
              });
              for (const childOpt of (childGroup.options || [])) {
                const childSku = String(childOpt.value || childOpt.label || '');
                const comboKey = parentSku + '_' + childSku;
                const mapInfo = mapping[comboKey];
                if (!mapInfo && Object.keys(mapping).length > 0) continue;
                const stock = capStock(mapInfo?.stkQty ?? (childOpt.disabled ? 0 : 10));
                const sold = mapInfo
                  ? mapInfo.sitmNoSlStatCd === 'SOUT' || mapInfo.spdNoSlStatCd === 'SOUT'
                  : !!childOpt.disabled;
                if (!sold) totalStock += stock;
                options.push({
                  name: childOpt.label || childOpt.value || '',
                  optionType: childGroup.title || 'option2',
                  sku: comboKey,
                  stock,
                  isSoldout: sold,
                });
              }
            }
          } else {
            const optionList = optionGroups[0]?.options ?? [];
            for (const opt of optionList) {
              const mapInfo = mapping[opt.value || ''];
              const stock = capStock(mapInfo?.stkQty ?? (opt.disabled ? 0 : 10));
              const sold = mapInfo ? mapInfo.sitmNoSlStatCd === 'SOUT' : !!opt.disabled;
              if (!sold) totalStock += stock;
              options.push({
                name: opt.label || opt.value || '',
                optionType: optionGroups[0]?.title || 'option',
                sku: opt.value || '',
                stock,
                isSoldout: sold,
              });
            }
          }
        }
      } catch { /* 옵션 조회 실패 시 기본 정보만 사용 */ }
    }

    if (options.length > 0) {
      isSoldout = totalStock === 0;
      totalStock = Math.min(totalStock, MAX_STOCK);
    } else {
      // 단일상품: sitmNoSlStatCd 또는 pdSlStatCd로 판정
      isSoldout = info.sitmNoSlStatCd === 'SOUT' || (info.pdSlStatCd && info.pdSlStatCd !== '01');
      totalStock = isSoldout ? 0 : 10;
    }

    const originalPrice = listPrice || sellPrice;

    // 배송비
    const dlvInfo = baseData?.data?.dlvInfo || {};
    const shippingFee = Number(dlvInfo.dvCst ?? dlvInfo.dvCstPolLst?.[0]?.dvCst ?? 0) || 0;
    const shippingType = shippingFee > 0 ? 'paid' : 'free';

    // 2026-04-22 PR-D: 롯데ON 실시간 동기화 sourceLeadDays — 확장 lotteon.js v1.2.2 와 동일 로직.
    //   thdyPdYn='Y' → 1, dlvInfo 정수 후보, API 응답 전체 JSON 의 "M/D 도착확률|예정" 스캔.
    let sourceLeadDays = null;
    try {
      sourceLeadDays = computeLotteonSourceLeadDays(baseData?.data || {}, info, dlvInfo);
    } catch { /* null fallback */ }

    return {
      sellPrice: Number(sellPrice),
      originalPrice: Number(originalPrice),
      totalStock,
      isSoldout,
      options,
      optionsReliable: true,
      shippingFee,
      shippingType,
      shippingFeeReliable: true,
      priceReliable: true,
      sourceLeadDays,
      sourceLeadDaysReliable: sourceLeadDays != null,
      arrivalLeadDaysV2: sourceLeadDays != null,
    };
  } catch (err) {
    console.warn(`[Updater] 롯데ON 파싱 실패 ${sourceId}:`, err.message);
    return null;
  }
}

// ─── 무신사 파싱 ───────────────────────────────────────────────────────────────
async function parseMusinsaDetail(sourceId) {
  try {
    const goodsNo = parseInt(sourceId, 10);
    if (isNaN(goodsNo)) throw new Error(`Invalid goodsNo: ${sourceId}`);

    const [detail, opts] = await Promise.all([
      getMusinsaDetail(goodsNo),
      getMusinsaOptions(goodsNo),
    ]);

    const stockReliable = opts.stockReliable !== false;
    const rawTotal = stockReliable ? opts.reduce((s, o) => {
      if (o.outOfStock || !o.activated) return s;
      return s + (o.remainQuantity ?? 99);
    }, 0) : 0;

    return {
      sellPrice: detail.salePrice || 0,
      originalPrice: detail.normalPrice || detail.salePrice || 0,
      benefitPrice: detail.benefitPrice ?? null,
      // v1.0.4 (2026-04-10): 백엔드 resolveSellPrice 체인 재계산용 raw + 부가 혜택 필드 forward
      // 이전엔 누락되어 update 경로에서 musinsaRaw=undefined → resolveSellPrice 가 salePrice 그대로 반환 (체인 미적용)
      musinsaRaw: detail.musinsaRaw,
      couponDcPrice: detail.couponDcPrice,
      memberDiscountRate: detail.memberDiscountRate,
      // v1.1.3 (2026-04-18): 등급할인 불가상품 판별 — 백엔드 defensive guard 에 forward
      isLimitedDc: detail.isLimitedDc,
      savePoint: detail.savePoint,
      memberSavePointRate: detail.memberSavePointRate,
      memberSaveMoneyRate: detail.memberSaveMoneyRate,
      isPrePoint: detail.isPrePoint,
      maxUsePointRate: detail.maxUsePointRate,
      benefitDetails: detail.benefitDetails,
      totalStock: stockReliable ? capStock(rawTotal) : 0,
      isSoldout: stockReliable ? rawTotal === 0 : false,
      stockReliable,
      optionsReliable: stockReliable,
      options: opts.map(o => ({
        name: o.name,
        optionType: o.optionName || 'size',
        sku: o.managedCode || '',
        stock: o.outOfStock ? 0 : (!o.activated ? 0 : capStock(o.remainQuantity ?? 99)),
        isSoldout: o.outOfStock || !o.activated,
      })),
      shippingFee: 0,
      shippingType: 'free', // 무신사는 항상 무료배송
      // 2026-04-22 PR-D: 실시간 자동 동기화 경로 sourceLeadDays 전파.
      //   musinsa.js v1.2.2 getDetail() 이 willReleaseDate 기반으로 계산한 값.
      //   서버 /update/receive 가 변동 감지 시 products.source_lead_days UPSERT.
      sourceLeadDays: detail?.sourceLeadDays ?? null,
      sourceLeadDaysReliable: detail?.sourceLeadDays != null,
    };
  } catch (err) {
    console.warn(`[Updater] 무신사 파싱 실패 ${sourceId}:`, err.message);
    throw err;
  }
}

function getFailureCooldownMinutes(reason) {
  const text = String(reason || '');
  if (/429|rate|too many|차단/i.test(text)) return 60;
  if (/404|not found|No data|Product .* not found/i.test(text)) return 24 * 60;
  if (/로그인|cookie|쿠키/i.test(text)) return 60;
  return 30;
}

function makeUpdateFailure(job, reason) {
  return {
    productId: job.productId,
    sourceId: job.sourceId,
    sourceMarket: job.sourceMarket,
    reason: String(reason || 'parser returned no result').slice(0, 300),
    cooldownMinutes: getFailureCooldownMinutes(reason),
  };
}

// ─── 소싱처별 파서 라우팅 ─────────────────────────────────────────────────────
async function parseProduct(job) {
  const { sourceMarket, sourceId, sourceUrl } = job;
  switch (sourceMarket) {
    case 'ssg':     return parseSsgDetail(sourceId, sourceUrl);
    case 'lotteon': return parseLotteonDetail(sourceId, sourceUrl);
    case 'musinsa': return parseMusinsaDetail(sourceId);
    default:
      console.warn(`[Updater] 알 수 없는 소싱처: ${sourceMarket}`);
      return null;
  }
}

// ─── 메인 업데이트 루프 ───────────────────────────────────────────────────────
let isUpdating = false;

export async function runUpdateCycle() {
  if (isUpdating) {
    console.log('[Updater] 이미 업데이트 중, 스킵');
    return;
  }
  isUpdating = true;

  try {
    // 1. 업데이트 필요 상품 목록 조회
    const data = await apiCall('/update/pending');
    const jobs = data?.jobs ?? [];
    if (jobs.length === 0) {
      console.log('[Updater] 업데이트 대기 상품 없음');
      return;
    }
    console.log(`[Updater] 업데이트 대기 상품: ${jobs.length}개`);

    // 2. 시장별로 그룹핑 → 마켓별 독립 워커 (musinsa/ssg/lotteon 각각 rate limit 독립)
    const byMarket = { musinsa: [], ssg: [], lotteon: [] };
    for (const job of jobs) {
      const sm = job.sourceMarket;
      if (byMarket[sm]) byMarket[sm].push(job);
    }
    console.log(`[Updater] 시장별 분배: musinsa=${byMarket.musinsa.length} ssg=${byMarket.ssg.length} lotteon=${byMarket.lotteon.length}`);

    const sharedFailures = [];
    const flushFailures = async (force = false) => {
      while (sharedFailures.length >= BATCH_SIZE || (force && sharedFailures.length > 0)) {
        const batch = sharedFailures.splice(0, BATCH_SIZE);
        try {
          await apiCall('/update/failures', {
            method: 'POST',
            body: JSON.stringify({ items: batch }),
          });
        } catch (err) {
          console.error('[Updater] 실패 보고 전송 실패:', err.message);
        }
        if (force) break;
      }
    };

    let musinsaSourceAccountId = null;
    if (byMarket.musinsa.length > 0) {
      const cookieState = await syncAllCookies({ includeSsg: false });
      if (cookieState?.musinsaLoggedIn && cookieState?.musinsaSourceAccountId) {
        musinsaSourceAccountId = cookieState.musinsaSourceAccountId;
      } else {
        const warning = cookieState?.musinsaWarning || MUSINSA_LOGIN_WARNING;
        console.warn(`[Updater] ${warning} — 무신사 업데이트 ${byMarket.musinsa.length}개 스킵`);
        await chrome.storage.local.set({ musinsaLoginWarning: warning });
        sharedFailures.push(...byMarket.musinsa.map(job => makeUpdateFailure(job, warning)));
        byMarket.musinsa = [];
        await flushFailures(false);
      }
    }

    // 전송 버퍼는 공유 (서버 /update/receive 는 market 혼합 허용)
    const sharedResults = [];
    const flushBuffer = async (force = false) => {
      while (sharedResults.length >= BATCH_SIZE || (force && sharedResults.length > 0)) {
        const batch = sharedResults.splice(0, BATCH_SIZE);
        try {
          await apiCall('/update/receive', {
            method: 'POST',
            body: JSON.stringify({ items: batch, sourceAccountId: musinsaSourceAccountId }),
          });
        } catch (err) {
          console.error('[Updater] 전송 실패:', err.message);
        }
        if (force) break; // 남은 부분이 BATCH_SIZE 미만이어도 1회만 flush
      }
    };

    // 마켓별 워커 함수. SSG는 보수적으로 1개 유지, API 기반 마켓은 제한된 병렬 처리.
    const marketWorker = async (marketName, marketJobs) => {
      const concurrency = Math.max(1, MARKET_UPDATE_CONCURRENCY[marketName] ?? 1);
      for (let i = 0; i < marketJobs.length; i += concurrency) {
        const chunk = marketJobs.slice(i, i + concurrency);
        await Promise.all(chunk.map(async (job) => {
          try {
            const parsed = await parseProduct(job);
            if (parsed) {
              sharedResults.push({
                sourceId: job.sourceId,
                sourceMarket: job.sourceMarket,
                ...parsed,
              });
            } else {
              sharedFailures.push(makeUpdateFailure(job, 'parser returned no result'));
            }
          } catch (err) {
            console.warn(`[Updater:${marketName}] 파싱 실패 스킵 ${job.sourceId}:`, err.message);
            sharedFailures.push(makeUpdateFailure(job, err.message));
          }
        }));

        // 버퍼가 BATCH_SIZE 이상 쌓이면 즉시 flush (여러 워커가 동시 호출 가능 — apiCall 자체 async 락 없어도 POST 독립)
        if (sharedResults.length >= BATCH_SIZE) {
          await flushBuffer(false);
        }
        if (sharedFailures.length >= BATCH_SIZE) {
          await flushFailures(false);
        }

        if (i + concurrency < marketJobs.length && marketName !== 'ssg') await delay(ITEM_DELAY_MS);
      }
    };

    // 3 마켓 병렬 실행 — 서로 다른 호스트라 rate limit 독립
    await Promise.all([
      byMarket.musinsa.length ? marketWorker('musinsa', byMarket.musinsa) : Promise.resolve(),
      byMarket.ssg.length ? marketWorker('ssg', byMarket.ssg) : Promise.resolve(),
      byMarket.lotteon.length ? marketWorker('lotteon', byMarket.lotteon) : Promise.resolve(),
    ]);

    // 남은 결과 최종 전송
    if (sharedResults.length > 0) {
      try {
        await apiCall('/update/receive', {
          method: 'POST',
          body: JSON.stringify({ items: sharedResults.splice(0, sharedResults.length), sourceAccountId: musinsaSourceAccountId }),
        });
      } catch (err) {
        console.error('[Updater] 최종 전송 실패:', err.message);
      }
    }
    await flushFailures(true);

    console.log('[Updater] 업데이트 사이클 완료');
  } catch (err) {
    console.error('[Updater] 업데이트 사이클 에러:', err.message);
  } finally {
    isUpdating = false;
  }
}

export function getIsUpdating() {
  return isUpdating;
}
