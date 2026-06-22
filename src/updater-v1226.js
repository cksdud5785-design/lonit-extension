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
} from './ssg-v1226.js';
import { computeLotteonSourceLeadDays } from './lotteon-v1226.js';
import { getUpdateSnapshot as getTwentynineCmUpdateSnapshot } from './twentynine-cm.js';
import { getDetail as getWconceptDetail, parseItem as parseWconceptItem } from './wconcept.js';
import { getDetail as getAbcmartDetail, parseItem as parseAbcmartItem } from './abcmart.js';
// 2026-06-12 신규 수집처 업데이트 연결: worksout(자체 API) + grandstage(abcmart 채널10002 위임).
import { getDetail as getWorksoutDetail, parseProduct as parseWorksoutProduct } from './worksout.js';
import { getDetail as getGsshopDetail, getOptions as getGsshopOptions, parseItem as parseGsshopItem } from './gsshop.js';
import { getDetail as getLotteimallDetail, getOptions as getLotteimallOptions } from './lotteimall.js';
import { fetchOptionData as fetchFashionplusOptionData, getDetail as getFashionplusDetail, parseItem as parseFashionplusItem } from './fashionplus.js';
import { getDetail as getAdidasDetail } from './adidas.js';
import { getDetail as getOliveyoungDetail, getOptions as getOliveyoungOptions } from './oliveyoung.js';
import { apiCall, getApiBackpressureDelayMs, isApiBackpressureActive, sendUpdateFailures, sendUpdateReceive } from './api.js';
import { MUSINSA_LOGIN_WARNING, syncAllCookies } from './source-account-sync.js';
import { Semaphore, TokenBucket, nextDelayFor, DEFAULT_EXT_UPDATE_CONFIG } from './update-scheduler.js';

console.log('[Lonit] updater.js v1.2.31 (windowless SSG + 적응 throttle 상한해제 + abcmart AIMD + 차단 fail-open 수정)');

// ─── 상수 ──────────────────────────────────────────────────────────────────────
// v1.1.5 (2026-04-18): 시장별 독립 워커 병렬 처리 — 각 마켓 rate limit 독립.
//   이전 v1.1.4: 450 products × 3~5s (parseProduct 내부 N 개 순차 API call) = 20~35min/cycle
//   이후 v1.1.5: 3 워커 병렬 → 약 7~12min/cycle (3x speedup)
//   효과: musinsa 9200건 2h → ≈40min
// 안전성: 각 소싱 API 는 서로 다른 호스트/rate-limit. 동일 호스트 내부 순차 유지.
const BATCH_SIZE = 25;      // 한 번에 서버에 전송할 아이템 수
// 2026-06-12: 배치간 딜레이 150→80. 마켓 내부 randomDelay(적응)가 실제 rate limit 담당,
//   이 값은 배치 사이 추가 여유라 줄여도 차단 영향 적음(차단 시 마켓별 적응 백오프가 흡수).
const ITEM_DELAY_MS = 80;
// 2026-06-12: SSG adaptive floor may probe below learned cliff, but only by trial-commit.
//   Runtime blocks update an EWMA cliff and resume at the learned safe floor after cooldown.
const SSG_ITEM_DELAY_MIN_MS = 1500;
const SSG_ITEM_DELAY_START_MS = 4200;
const SSG_ITEM_DELAY_MAX_MS = 60_000;
// 2026-06-12: speed-up every 10 clean SSG successes while respecting the learned floor.
const SSG_ITEM_SPEED_UP_EVERY = 10;
// 2026-06-12: 차단 쿨다운 10분→4분. HTTP 429 는 soft rate-limit(수십초~수분 내 회복)이라
//   10분 전체 정지는 과함. cliff 메모리(safeFloor 상승)가 재차단 방지의 핵심이므로 쿨다운은
//   짧게 두고 회복을 빠르게. 회복 후 delay 는 학습된 safeFloor 이상이라 즉시 재429 위험 낮음.
const SSG_ITEM_BLOCK_COOLDOWN_MS = 4 * 60_000;
const SSG_DETAIL_REFRESH_MS = 24 * 60 * 60 * 1000;
const SSG_DETAIL_ROLLING_SHARDS = 24;
const UPDATE_MARKETS = ['musinsa', 'ssg', 'lotteon', '29cm', 'wconcept', 'abcmart', 'worksout', 'grandstage', 'gsshop', 'lotteimall', 'fashionplus', 'adidas', 'oliveyoung'];
// 2026-06-12: 저차단 JSON-API 마켓 동시성 상향(lotteon 3→6, 29cm 2→4). config perMarketRatePerSec=0
//   (무제한 안전판단)인 마켓들. musinsa 는 4 유지하되 내부 AIMD 적응 딜레이로 가속(차단 시 자동 백오프).
//   abcmart=1(전역 throttle 직렬), wconcept=1(detail stub). 차단 늘면 popup 모니터로 관측→조정.
const MARKET_UPDATE_CONCURRENCY = { musinsa: 4, ssg: 8, lotteon: 6, '29cm': 4, wconcept: 1, abcmart: 1, worksout: 2, grandstage: 1, gsshop: 1, lotteimall: 1, fashionplus: 2, adidas: 2, oliveyoung: 1 };
const MAX_STOCK = 10;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const capStock = (n) => Math.min(Math.max(0, n ?? 0), MAX_STOCK);
const randomBetween = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));
let ssgUpdateDelayMs = SSG_ITEM_DELAY_START_MS;
let ssgUpdateSuccesses = 0;
let ssgUpdateBlockedUntil = 0;
let ssgDetailQueue = Promise.resolve();
// 2026-06-12: cliff memory uses EWMA, then lowers the floor only through safe trial probes.
let ssgSafeFloorMs = SSG_ITEM_DELAY_MIN_MS;     // 회복이 내려갈 수 있는 적응 바닥
let ssgCliffEwmaMs = null;
let ssgProbe = null;
let ssgProbeIntervalMultiplier = 1;
const SSG_FLOOR_PROBE_EVERY = 40;
const SSG_PROBE_COMMIT_SUCCESSES = 200;
// 2026-06-12: 운영 로그상 SSG 실제 안전 한계 ~2900-3000ms(추정 2400보다 높음). 안전여유율속 1.12 는
//   너무 타이트해 safeFloor 가 실 cliff 아래→반복 429. 안전율속 1.30 으로 safeFloor 를 cliff 위로
//   확실히 올려 수렴 빠르게. 하향 probe 는 SSG 가 헤드룸 없어(찔러봐야 429만) 비활성.
const SSG_CLIFF_SAFETY_RATIO = 1.30;
const SSG_DOWNWARD_PROBE_ENABLED = false;

// ── 모니터링 텔레메트리 (2026-06-12) ─────────────────────────────────────────
//   서비스워커의 마켓별 처리량/차단/적응 딜레이를 관측. 속도 개선이 차단을 늘리지 않는지를
//   사용자가 확인(popup/콘솔)할 수 있게 한다. 순수 관측 — 크롤링 동작에 영향 없음.
const STATS_THROUGHPUT_WINDOW_MS = 60_000;   // 분당 처리량 윈도우
const STATS_PERSIST_DEBOUNCE_MS = 10_000;    // storage 쓰기 디바운스
const marketUpdateStats = new Map();         // market → { processed, ok, fail, blocks, lastBlockAt, lastBlockReason, lastEventAt, recent[], stockReliableTrue, stockReliableFalse, priceUnreliable }
function statFor(market) {
  let s = marketUpdateStats.get(market);
  if (!s) {
    s = {
      processed: 0, ok: 0, fail: 0, blocks: 0, lastBlockAt: 0, lastBlockReason: '', lastEventAt: 0, recent: [],
      // GAP-1(2026-06-12): 재고/가격 신뢰도 집계 — stockReliable=false 로 재고를 영영 안 푸시하는
      //   lost-sale(품절표기 과다)를 사용자가 관측. ok 인 파싱만 집계.
      stockReliableTrue: 0, stockReliableFalse: 0, priceUnreliable: 0,
    };
    marketUpdateStats.set(market, s);
  }
  return s;
}
// GAP-3(2026-06-12): /update/receive 전송 실패는 batch splice 후라 silent 유실 → 전역 관측.
const receiveStats = { fail: 0, lastErrorAt: 0, lastError: '', lastLostCount: 0 };
function recordReceiveFailure(lostCount, errMsg) {
  receiveStats.fail++;
  receiveStats.lastErrorAt = Date.now();
  receiveStats.lastError = String(errMsg || '').slice(0, 200);
  receiveStats.lastLostCount = Number(lostCount) || 0;
  schedulePersistStats();
}
// GAP-2: 차단/레이트리밋 류 에러 판별(403/429/captcha/WAF/rate/too many/차단). 순수 관측용.
function isBlockLikeError(reason) {
  return /403|429|rate.?limit|too many|captcha|\bWAF\b|차단/i.test(String(reason || ''));
}
function trimRecent(s, now) {
  const cutoff = now - STATS_THROUGHPUT_WINDOW_MS;
  while (s.recent.length && s.recent[0] < cutoff) s.recent.shift();
}
function recordMarketResult(market, ok, meta) {
  const s = statFor(market);
  const now = Date.now();
  s.processed++;
  if (ok) s.ok++; else s.fail++;
  // GAP-1: 성공 파싱의 신뢰도 플래그 집계(meta = { stockReliable, priceReliable }).
  if (ok && meta) {
    if (meta.stockReliable === false) s.stockReliableFalse++;
    else if (meta.stockReliable === true) s.stockReliableTrue++;
    if (meta.priceReliable === false) s.priceUnreliable++;
  }
  s.lastEventAt = now;
  s.recent.push(now);
  trimRecent(s, now);
  schedulePersistStats();
}
function recordMarketBlock(market, reason) {
  const s = statFor(market);
  s.blocks++;
  s.lastBlockAt = Date.now();
  if (reason) s.lastBlockReason = String(reason).slice(0, 120);
  schedulePersistStats();
}
export function getUpdateStats() {
  const now = Date.now();
  const markets = {};
  for (const [market, s] of marketUpdateStats) {
    trimRecent(s, now);
    markets[market] = {
      processed: s.processed,
      ok: s.ok,
      fail: s.fail,
      blocks: s.blocks,
      perMinute: s.recent.length,                       // 최근 60초 처리량
      lastBlockAt: s.lastBlockAt || null,
      lastBlockReason: s.lastBlockReason || null,        // GAP-2: 차단 사유
      lastEventAt: s.lastEventAt || null,
      stockReliableTrue: s.stockReliableTrue,            // GAP-1: 재고 푸시된 건수
      stockReliableFalse: s.stockReliableFalse,          // GAP-1: 재고 미신뢰(lost-sale 후보)
      priceUnreliable: s.priceUnreliable,                // GAP-1: 가격 미신뢰
    };
  }
  return {
    at: now,
    markets,
    receive: {                                           // GAP-3: 전송 실패 관측
      fail: receiveStats.fail,
      lastErrorAt: receiveStats.lastErrorAt || null,
      lastError: receiveStats.lastError || null,
      lastLostCount: receiveStats.lastLostCount,
    },
    ssg: {
      delayMs: ssgUpdateDelayMs,                         // 현재 적응 딜레이
      safeFloorMs: ssgSafeFloorMs,                       // 학습된 안전 바닥(cliff 바로 위)
      cliffEwmaMs: Number.isFinite(ssgCliffEwmaMs) ? Math.floor(ssgCliffEwmaMs) : null,
      blockedForMs: Math.max(0, ssgUpdateBlockedUntil - now),
      successStreak: ssgUpdateSuccesses,
    },
  };
}
let statsPersistTimer = null;
function schedulePersistStats() {
  if (statsPersistTimer) return;
  statsPersistTimer = setTimeout(() => {
    statsPersistTimer = null;
    try { chrome.storage.local.set({ extUpdateStats: getUpdateStats() }); } catch { /* SW 종료 등 무시 */ }
  }, STATS_PERSIST_DEBOUNCE_MS);
}

// ── SSG 적응 상태 보존 (2026-06-12) ─────────────────────────────────────────
//   MV3 서비스워커는 자주 종료 → 학습한 안전속도(delay/safeFloor)가 매번 초기화되면
//   같은 cliff 를 재차단한다. 학습값을 storage 에 보존하고 SW 재시작 시 복원하여 수렴 유지.
//   복원값은 이전에 "차단 안 되던" 값이라 차단 위험을 추가하지 않는다(순수 보존).
const SSG_STATE_KEY = 'ssgAdaptiveState';
let ssgStatePersistTimer = null;
function persistSsgState(immediate = false) {
  const write = () => {
    ssgStatePersistTimer = null;
    try {
      chrome.storage.local.set({
        [SSG_STATE_KEY]: {
          delayMs: ssgUpdateDelayMs,
          safeFloorMs: ssgSafeFloorMs,
          cliffEwmaMs: Number.isFinite(ssgCliffEwmaMs) ? Math.floor(ssgCliffEwmaMs) : null,
          at: Date.now(),
        },
      });
    } catch { /* SW 종료 등 무시 */ }
  };
  if (immediate) { if (ssgStatePersistTimer) { clearTimeout(ssgStatePersistTimer); } write(); return; }
  if (ssgStatePersistTimer) return;
  ssgStatePersistTimer = setTimeout(write, STATS_PERSIST_DEBOUNCE_MS);
}
async function restoreSsgState() {
  try {
    const got = await chrome.storage.local.get(SSG_STATE_KEY);
    const s = got?.[SSG_STATE_KEY];
    if (!s) return;
    if (Number.isFinite(s.safeFloorMs)) {
      ssgSafeFloorMs = Math.min(SSG_ITEM_DELAY_MAX_MS, Math.max(SSG_ITEM_DELAY_MIN_MS, Math.floor(s.safeFloorMs)));
    }
    if (Number.isFinite(s.cliffEwmaMs)) {
      ssgCliffEwmaMs = Math.min(8000, Math.max(1000, Math.floor(s.cliffEwmaMs)));
      // 새 안전율속(SSG_CLIFF_SAFETY_RATIO) 즉시 반영 — 재로드 직후 옛 타이트 floor 로 1회 429 나는 것 방지.
      ssgSafeFloorMs = Math.max(ssgSafeFloorMs, Math.min(SSG_ITEM_DELAY_MAX_MS, Math.floor(ssgCliffEwmaMs * SSG_CLIFF_SAFETY_RATIO)));
    }
    if (Number.isFinite(s.delayMs)) {
      // 복원 딜레이는 학습된 안전 바닥 이상으로 클램프 — 절대 cliff 아래로 시작하지 않는다.
      ssgUpdateDelayMs = Math.min(SSG_ITEM_DELAY_MAX_MS, Math.max(ssgSafeFloorMs, Math.floor(s.delayMs)));
    }
    console.log(`[Updater:SSG] 적응 상태 복원: delay=${ssgUpdateDelayMs}ms, floor=${ssgSafeFloorMs}ms`);
  } catch { /* 무시 */ }
}
restoreSsgState();

export function extractLotteonPromotionPrice(promoData) {
  const root = promoData?.data ?? promoData ?? {};
  const priceInfo = root.priceInfo ?? root;
  const candidates = [
    priceInfo.immdDcAplyTotAmt,
    priceInfo.orderDcAplyTotAmt,
    priceInfo.bestBenefitPrice,
    priceInfo.discountedPrice,
  ];
  for (const value of candidates) {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

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

export function isSsgAccessRestrictedHtml(html = '') {
  const body = String(html || '');
  return [
    /<title>\s*flagMsg\s*<\/title>/i,
    /flagMsg/i,
    /임직원\s*및\s*사업자\s*회원만\s*구매\s*가능한\s*상품/i,
    /로그인\s*하신\s*후\s*연결이\s*가능/i,
    /회원만\s*구매\s*가능한\s*상품/i,
  ].some((pattern) => pattern.test(body));
}

export function shouldOpenSsgBlockCooldown(reason = '') {
  const text = String(reason || '');
  return /SSG detail captcha|HTTP 403|HTTP 429/i.test(text);
}

export function isTransientSourceHttpStatus(status) {
  const code = Number(status);
  return code === 500 || code === 502 || code === 503 || code === 504;
}

export function buildLotteonMallCandidates(sourceUrl = '') {
  const mallMatch = String(sourceUrl || '').match(/mall_no=(\d+)/);
  const candidates = [mallMatch?.[1], '1', '2'].filter(Boolean).map(String);
  return [...new Set(candidates)];
}

async function fetchSourceJsonWithRetry(url, options = {}, { label = 'source fetch', maxAttempts = 3, baseDelayMs = 700 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res.json();
    lastError = new Error(`${label} HTTP ${res.status}`);
    if (!isTransientSourceHttpStatus(res.status) || attempt === maxAttempts) break;
    const jitter = randomBetween(0, 250);
    await delay(baseDelayMs * attempt + jitter);
  }
  throw lastError || new Error(`${label} failed`);
}

async function waitSsgUpdateSlot() {
  const remainingCooldownMs = ssgUpdateBlockedUntil - Date.now();
  if (remainingCooldownMs > 0) {
    console.warn(`[Updater:SSG] 차단 쿨다운 대기 ${Math.ceil(remainingCooldownMs / 1000)}초`);
    await delay(remainingCooldownMs);
  }
  const adaptiveJitterCap = Math.min(350, Math.max(120, Math.floor(ssgUpdateDelayMs * 0.10)));
  await delay(ssgUpdateDelayMs + randomBetween(0, adaptiveJitterCap));
}

function markSsgUpdateBlocked(reason = 'blocked') {
  const currentDelay = ssgUpdateDelayMs;
  const abortedProbeBaseFloorMs = ssgProbe?.baseFloorMs ?? null;
  if (ssgProbe) {
    ssgSafeFloorMs = ssgProbe.baseFloorMs;
    ssgProbeIntervalMultiplier = Math.min(12, ssgProbeIntervalMultiplier * 2);
    ssgProbe = null;
  }
  ssgCliffEwmaMs = (ssgCliffEwmaMs || currentDelay) * (1 - 0.35) + currentDelay * 0.35;
  ssgSafeFloorMs = Math.max(SSG_ITEM_DELAY_MIN_MS, Math.floor(ssgCliffEwmaMs * SSG_CLIFF_SAFETY_RATIO));
  if (abortedProbeBaseFloorMs != null) {
    ssgSafeFloorMs = Math.max(ssgSafeFloorMs, abortedProbeBaseFloorMs);
  }
  ssgUpdateDelayMs = ssgSafeFloorMs;
  ssgUpdateSuccesses = 0;
  ssgUpdateBlockedUntil = Date.now() + SSG_ITEM_BLOCK_COOLDOWN_MS;
  recordMarketBlock('ssg');
  persistSsgState(true);   // 학습된 cliff 는 즉시 보존 (SW 종료 전 유실 방지)
  console.warn(`[Updater:SSG] 차단 감지: ${reason}. delay=${ssgUpdateDelayMs}ms, safeFloor=${ssgSafeFloorMs}ms, ${Math.round(SSG_ITEM_BLOCK_COOLDOWN_MS / 1000)}초 쿨다운`);
}

function markSsgUpdateSuccess() {
  ssgUpdateSuccesses++;

  if (ssgProbe) {
    ssgProbe.successes++;
    ssgUpdateDelayMs = ssgProbe.trialFloorMs;
    if (ssgProbe.successes >= SSG_PROBE_COMMIT_SUCCESSES) {
      ssgSafeFloorMs = ssgProbe.trialFloorMs;
      ssgProbe = null;
      ssgProbeIntervalMultiplier = 1;
      console.log(`[Updater:SSG] 바닥 probe 커밋: floor → ${ssgSafeFloorMs}ms`);
      persistSsgState();
    }
    return;
  }

  if (ssgUpdateSuccesses % SSG_ITEM_SPEED_UP_EVERY === 0) {
    // 회복은 학습된 안전 바닥(cliff 바로 위)까지만 — 같은 한계선을 다시 때리지 않는다.
    const nextDelay = Math.max(ssgSafeFloorMs, Math.floor(ssgUpdateDelayMs * 0.9));
    if (nextDelay < ssgUpdateDelayMs) {
      console.log(`[Updater:SSG] 속도 증가: ${ssgUpdateDelayMs}ms → ${nextDelay}ms (floor ${ssgSafeFloorMs}ms)`);
      ssgUpdateDelayMs = nextDelay;
      persistSsgState();
    }
  }

  if (SSG_DOWNWARD_PROBE_ENABLED && ssgUpdateSuccesses % (SSG_FLOOR_PROBE_EVERY * ssgProbeIntervalMultiplier) === 0 && ssgUpdateSuccesses > 0) {
    const trialFloorMs = Math.floor(ssgSafeFloorMs * 0.98);
    if (trialFloorMs >= SSG_ITEM_DELAY_MIN_MS) {
      ssgProbe = { baseFloorMs: ssgSafeFloorMs, trialFloorMs, successes: 0 };
      ssgUpdateDelayMs = trialFloorMs;
      console.log(`[Updater:SSG] 바닥 probe 시작: floor ${ssgSafeFloorMs}ms → trial ${trialFloorMs}ms`);
      persistSsgState();
    }
  }
}

function parseTimestampMs(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function hashString(value = '') {
  const text = String(value);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function normalizeLeadDays(value) {
  const lead = Number(value);
  if (!Number.isFinite(lead)) return null;
  const clamped = Math.floor(lead);
  return clamped >= 1 && clamped <= 30 ? clamped : null;
}

function shouldFetchSsgDetail(sourceId, searchSnapshot, job = {}) {
  if (!searchSnapshot) return true;
  if (searchSnapshot.sourceHasOptions === true) return true;
  // 2026-06-12 옵션미수집 재발방지: 서버가 "DB에 옵션 0개"인 SSG 상품에 ssgNeedsDetail 플래그를
  //   주면 강제 detail fetch(스냅샷 sourceHasOptions 감지가 놓친 옵션 상품 보강).
  if (job.ssgNeedsDetail === true) return true;

  const lastDetailMs = parseTimestampMs(job.ssgLastDetailAt);
  if (lastDetailMs != null && Date.now() - lastDetailMs < SSG_DETAIL_REFRESH_MS) return false;

  const shard = new Date().getUTCHours() % SSG_DETAIL_ROLLING_SHARDS;
  return hashString(sourceId) % SSG_DETAIL_ROLLING_SHARDS === shard;
}

async function runSsgDetailFetch(task) {
  const previous = ssgDetailQueue.catch(() => undefined);
  let release = () => {};
  ssgDetailQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await waitSsgUpdateSlot();
    return await task();
  } finally {
    release();
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
  const simpleStockReliable = (hasQty || explicitSoldout) && !sourceHasOptions;
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
    stockReliable: simpleStockReliable,
    ssgStockReliableV2: simpleStockReliable,
    ssgDetailParsedV2: false,
    ssgDetailStockReliableV2: simpleStockReliable,
    optionsReliable: !sourceHasOptions,
    sourceHasOptions,
    sourceSearchTitle: item.itemNm || '',
    // 기획전(deal) 마커 — itemView 로 업데이트 불가한 딜 상품 감지용. 비어있지 않으면 딜.
    salestrNo: String(item.salestrNo || ''),
  };
}

// ─── SSG 기획전(deal) 상품 감지 ───────────────────────────────────────────────
// search API 의 salestrNo 가 있으면 기획전(딜) 상품 — dealItemView 로만 판매돼 itemView
// 업데이트가 불가하고, 기존엔 Content Script 탭 폴백이 매 사이클 창을 띄웠다. salestrNo
// 가 있고 itemView 파싱까지 실패한 경우에만(=정상 상품은 미도달) dead 로 전파해 서버가
// status='deleted'+delist 하게 한다. 정상 상품 오삭제 방지 위해 파싱실패와 AND 조건.
export function isSsgDealSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.salestrNo);
}
export function makeSsgDealDeadError(salestrNo, phase = 'itemView 미지원') {
  // 메시지에 '기획전(deal)' 포함 → 서버 isSSGPermanentDeadReason 매칭.
  const err = new Error(`SSG 기획전(deal) 상품 — salestrNo=${salestrNo}, ${phase}`);
  err.__ssgDealDead = true;
  return err;
}

// ─── SSG fetchDetail 래퍼 ─────────────────────────────────────────────────────
// ssg.js의 fetchDetail은 module-scoped function이라 import 불가 → 직접 호출
async function parseSsgDetail(sourceId, sourceUrl, job = {}) {
  let searchSnapshot = null;
  const searchSnapshotPromise = fetchSsgSearchSnapshot(sourceId, sourceUrl).catch((err) => {
    console.warn(`[Updater] SSG Search API 실패 ${sourceId}:`, err.message);
    return null;
  });
  searchSnapshot = await searchSnapshotPromise;

  if (searchSnapshot && !shouldFetchSsgDetail(sourceId, searchSnapshot, job)) {
    const existingLead = normalizeLeadDays(job.sourceLeadDays);
    return {
      ...searchSnapshot,
      sourceLeadDays: searchSnapshot.sourceLeadDays ?? existingLead,
      sourceLeadDaysReliable: searchSnapshot.sourceLeadDays != null,
      detailFetchSkipped: true,
      detailFetchBlocked: false,
    };
  }

  try {
    const detailResponse = await runSsgDetailFetch(async () => {
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
    if (isSsgAccessRestrictedHtml(html)) {
      throw new Error('SSG detail access restricted');
    }
      return { html, siteNo };
    });
    const { html, siteNo } = detailResponse;
    searchSnapshot = searchSnapshot ?? await searchSnapshotPromise;

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
      // 기획전(deal) 상품은 itemView 에 resultItemObj/판매가가 없다 → salestrNo 있으면 dead 전파.
      if (isSsgDealSnapshot(searchSnapshot)) throw makeSsgDealDeadError(searchSnapshot.salestrNo, 'itemView 미지원');
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
      // 기획전(deal) 상품은 itemView 옵션 파싱 불가 → salestrNo 있으면 dead 전파(자동 제거).
      if (isSsgDealSnapshot(searchSnapshot)) throw makeSsgDealDeadError(searchSnapshot.salestrNo, 'itemView 옵션 미파싱');
      try {
        // 2026-06-12: windowless 전용(useContentScript=false) — 탭/창 안 띄움. 부족하면 아래
        //   search-snapshot 재고로 graceful 처리(잘못된 옵션 재고는 푸시하지 않음).
        console.warn(`[Updater] SSG 옵션 파싱 보강 fallback ${sourceId} (windowless)`);
        const fallbackDetail = await fetchSsgFullDetail(sourceId, siteNo, false);
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
    // 기획전(deal) dead 는 searchSnapshot 으로 swallow 하지 않고 failure 로 전파(→ 서버 status='deleted').
    if (err?.__ssgDealDead) throw err;
    searchSnapshot = searchSnapshot ?? await searchSnapshotPromise;
    if (shouldOpenSsgBlockCooldown(err?.message || '')) {
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
        detailBlockReason: err?.message || 'SSG detail fetch failed',
      };
    }
    throw err;
  }
}

// ─── 롯데ON fetchDetail 래퍼 ──────────────────────────────────────────────────
async function parseLotteonDetail(sourceId, sourceUrl) {
  try {
    const pdId = String(sourceId);
    const encodedPdId = encodeURIComponent(pdId);
    let mallNo = '1';
    let baseData = null;
    let baseError = null;

    // pbf API: base 정보 조회. 롯데ON pbf 5xx는 샘플에서 일시 장애로 확인되어
    // 짧게 재시도하고, URL mall_no가 틀리거나 엣지 장애일 때 안전 후보를 순차 시도한다.
    for (const candidateMallNo of buildLotteonMallCandidates(sourceUrl)) {
      const baseUrl = `https://pbf.lotteon.com/product/v2/detail/search/base/pd/${encodedPdId}?mall_no=${candidateMallNo}&isNotContainOptMapping=true`;
      try {
        baseData = await fetchSourceJsonWithRetry(baseUrl, {
          headers: { 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' },
        }, { label: 'pbf base', maxAttempts: 3 });
        mallNo = candidateMallNo;
        break;
      } catch (err) {
        baseError = err;
        console.warn(`[Updater] 롯데ON pbf base 후보 실패 ${pdId} mall_no=${candidateMallNo}:`, err?.message || err);
      }
    }
    if (!baseData) throw baseError || new Error('pbf base failed');

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
    let benefitPrice = null;
    let cardBenefitPrice = null;
    let priceReliable = false;
    let priceReliabilityReason = 'lotteon_list_price_fallback';
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
        const promoData = await fetchSourceJsonWithRetry('https://pbf.lotteon.com/product/v2/extlmsa/promotion/qtyChangeFavorInfoList', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' },
          body: JSON.stringify(promoBody),
        }, { label: 'pbf promotion', maxAttempts: 2 });
        const pd = promoData?.data || {};
        const promoPriceInfo = pd.priceInfo || pd;
        const immediatePrice = Number(promoPriceInfo.immdDcAplyTotAmt || 0);
        const orderPrice = Number(promoPriceInfo.orderDcAplyTotAmt || 0);
        const promoPrice = extractLotteonPromotionPrice(promoData);
        if (promoPrice && promoPrice > 0) {
          sellPrice = promoPrice;
          benefitPrice = immediatePrice || null;
          cardBenefitPrice = orderPrice || null;
          priceReliable = true;
          priceReliabilityReason = immediatePrice || orderPrice
            ? 'lotteon_promotion'
            : 'lotteon_no_promotion';
        }
      } catch { /* promotion API 실패 → listPrice fallback */ }
    }

    // 옵션 매핑
    const options = [];
    let totalStock = 0;
    let isSoldout = false;
    // 2026-06-12 차단검수: 옵션 API 가 차단/실패(throw)했는데 catch 로 삼키고 단일상품 분기로
    //   빠지면 옵션 있는 상품인데 stock=10 을 reliable 로 푸시(=fail-open). 실패를 추적해
    //   unreliable 마킹 → 잘못된 재고는 푸시 안 함(가격은 base+promo 라 유지).
    let optionFetchFailed = false;

    if (spdNo && sitmNo) {
      try {
        const optUrl = `https://pbf.lotteon.com/product/v2/detail/option/mapping/${spdNo}/${sitmNo}?trNo=${trNo}&trGrpCd=${trGrpCd}&lrtrNo=${lrtrNo}&pdNo=${encodeURIComponent(pdId)}`;
        const optData = await fetchSourceJsonWithRetry(optUrl, {
          headers: { 'Referer': `https://www.lotteon.com/p/product/${pdId}`, 'User-Agent': 'Mozilla/5.0' },
        }, { label: 'pbf option', maxAttempts: 2 });
        const optionGroups = optData?.data?.optionInfo?.optionList ?? [];
        const mapping = optData?.data?.optionInfo?.optionMappingInfo ?? {};

        // 2026-06-12: 서버 buildLotteonOptionsFromAxes(RCA #11) 정렬 — phantom stock 차단.
        //   기존 확장: 매핑 누락 시 stkQty 10 으로 채워 실재고(예 4)를 10 으로 과대보고→오버셀링.
        //   서버: stkQty 없으면 0, 2축 매핑 누락=SKU 미존재→soldout, FREE 단일옵션(stkQty=0 버그)만
        //   기본재고 할당. 보수적(과대보고 제거)이라 최악도 오품절(회복가능)일 뿐 오버셀링 아님.
        if (optionGroups.length === 2) {
          // 2축: axis0 × axis1 cross-product. 매핑 키 = `${a.value}_${b.value}` (서버와 동일).
          const axis0 = optionGroups[0]?.options || [];
          const axis1 = optionGroups[1]?.options || [];
          for (const a of axis0) {
            for (const b of axis1) {
              const key = `${a.value}_${b.value}`;
              const mapInfo = mapping[key];
              const sold = a.disabled === true || b.disabled === true || !mapInfo
                || mapInfo.sitmNoSlStatCd === 'SOUT' || mapInfo.spdNoSlStatCd === 'SOUT';
              options.push({
                name: `${a.label ?? a.value ?? ''}/${b.label ?? b.value ?? ''}`,
                optionType: optionGroups[1]?.title || 'option',
                sku: key,
                stock: Number(mapInfo?.stkQty) || 0,
                isSoldout: sold,
              });
            }
          }
        } else {
          // 단축(+3축이상 fallback): optionList[0].options 평탄화. 매핑 누락은 stkQty 0(soldout 강제 안 함).
          const optionList = optionGroups[0]?.options ?? [];
          for (const opt of optionList) {
            const mapInfo = mapping[opt.value || ''];
            const sold = opt.disabled === true || mapInfo?.sitmNoSlStatCd === 'SOUT';
            options.push({
              name: opt.label || opt.value || '',
              optionType: optionGroups[0]?.title || 'option',
              sku: opt.value || '',
              stock: Number(mapInfo?.stkQty) || 0,
              isSoldout: sold,
            });
          }
        }
        // FREE 단일옵션 stkQty=0 버그 대응: 전 옵션 stkQty 0 인데 판매중 옵션 존재 시 기본재고 할당.
        //   매핑 누락 soldout 옵션은 제외돼 phantom 부풀리기 재발 안 함(서버 totalStock 로직 정렬).
        const rawTotal = options.reduce((sum, o) => sum + (o.isSoldout ? 0 : o.stock), 0);
        if (rawTotal === 0 && options.length > 0 && !options.every((o) => o.isSoldout)) {
          for (const o of options) {
            if (!o.isSoldout && o.stock === 0) o.stock = MAX_STOCK;
          }
        }
        for (const o of options) {
          o.stock = capStock(o.stock);
          if (!o.isSoldout) totalStock += o.stock;
        }
      } catch { optionFetchFailed = true; /* 옵션 조회 실패 → 아래서 unreliable 마킹 */ }
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
      // 옵션 fetch 실패 OR base 응답에 상품 식별자(spdNo/sitmNo) 없음(=비정상/빈 200) 시
      // 옵션·재고 unreliable → 서버가 조작된 stock=10 을 푸시 안 함(가격은 priceReliable 로 별도 게이트).
      optionsReliable: Boolean(spdNo && sitmNo) && !optionFetchFailed,
      stockReliable: Boolean(spdNo && sitmNo) && !optionFetchFailed,
      shippingFee,
      shippingType,
      shippingFeeReliable: true,
      benefitPrice,
      cardBenefitPrice,
      priceReliable,
      priceReliabilityReason,
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

async function parseTwentynineCmDetail(sourceId) {
  const snapshot = await getTwentynineCmUpdateSnapshot(sourceId);
  // 옵션 fetch 차단/실패 시 fallbackOptions(stock=10)가 들어와 있으므로 재고·옵션 unreliable.
  const optFailed = snapshot?.__optionsFetchFailed === true;
  return {
    ...snapshot,
    priceReliable: true,
    stockReliable: !optFailed,
    optionsReliable: !optFailed,
  };
}

async function parseWconceptDetailForUpdate(sourceId, sourceUrl) {
  const detail = await getWconceptDetail(sourceId);
  const snapshot = parseWconceptItem(detail, { productId: sourceId, sourceUrl });
  return {
    ...snapshot,
    // W컨셉 현재 파서는 옵션별 실제 재고를 확정하지 못하므로 가격만 업데이트한다.
    stockReliable: false,
    optionsReliable: false,
    priceReliable: true,
  };
}

async function parseAbcmartDetailForUpdate(sourceId) {
  const detail = await getAbcmartDetail(sourceId);
  return {
    ...parseAbcmartItem({ PRDT_NO: sourceId }, detail),
    priceReliable: true,
    stockReliable: true,
    optionsReliable: true,
  };
}

// 2026-06-12: worksout 업데이트 — getDetail(재고 entries fetch) + parseProduct(완전 shape).
//   ★재고 신뢰: getDetail 이 실재고를 받았을 때만 detail.__stockEntries 채움. 없으면 옵션 stock
//   이 fallback 10(phantom) 일 수 있어 stockReliable=false 로 내려 잘못된 재고 푸시 방지.
async function parseWorksoutDetailForUpdate(sourceId, sourceUrl) {
  const detail = await getWorksoutDetail(sourceId);
  const product = parseWorksoutProduct(detail, { productId: String(sourceId), sourceUrl });
  if (!product) return null;
  const stockReal = Array.isArray(detail?.__stockEntries) && detail.__stockEntries.length > 0;
  const options = Array.isArray(product.options) ? product.options : [];
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  return {
    sellPrice: Number(product.sellPrice) || 0,
    originalPrice: Number(product.originalPrice) || Number(product.sellPrice) || 0,
    options,
    totalStock,
    isSoldout: product.isSoldout === true || totalStock === 0,
    sourceLeadDays: null,
    // 가격 데이터 없으면(currentPrice/initialPrice 둘 다 0) priceReliable=false → 가격 0 푸시 방지.
    priceReliable: Number(product.sellPrice) > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

// 2026-06-12: grandstage 업데이트 — a-rt.com 채널 10002(abcmart 와 동일 API/파서, host만 다름).
//   abcmart getOptions 는 stkQty 없으면 0(phantom 없음) → stockReliable 안전.
async function parseGrandstageDetailForUpdate(sourceId) {
  const detail = await getAbcmartDetail(sourceId, { channel: '10002' });
  return {
    ...parseAbcmartItem({ PRDT_NO: sourceId }, detail),
    sourceLeadDays: null,
    priceReliable: true,
    stockReliable: true,
    optionsReliable: true,
  };
}

// ─── 소싱처별 파서 라우팅 ─────────────────────────────────────────────────────
async function parseGsshopDetailForUpdate(sourceId, sourceUrl) {
  const detail = await getGsshopDetail(sourceId);
  const product = parseGsshopItem({ productCd: sourceId }, detail);
  if (!product) return null;
  const options = Array.isArray(product.options) ? product.options : getGsshopOptions(detail);
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  const sellPrice = Number(detail?.pmo?.prc?.salePrc ?? product.sellPrice) || 0;
  const stockReal = Array.isArray(detail?.prd?.attrTypList)
    && options.length > 0
    && !options.some(o => o?.isFallback);
  return {
    sellPrice,
    originalPrice: Number(product.originalPrice) || sellPrice,
    options,
    totalStock,
    isSoldout: product.isSoldout === true || totalStock === 0,
    sourceLeadDays: null,
    priceReliable: sellPrice > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

async function parseLotteimallDetailForUpdate(sourceId, sourceUrl) {
  const detail = await getLotteimallDetail(sourceId);
  if (!detail) return null;
  const options = await getLotteimallOptions(sourceId, {
    __goodsInfo: detail.__goodsInfo,
    inStock: detail.inStock,
  });
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  const sellPrice = Number(detail.sellPrice) || 0;
  const hasRealInventory = Array.isArray(detail.__goodsInfo)
    && detail.__goodsInfo.some(entry => entry && Object.prototype.hasOwnProperty.call(entry, 'inv_qty'));
  const stockReal = hasRealInventory
    && options.length > 0
    && !options.some(o => o?.isFallback);
  return {
    sellPrice,
    originalPrice: Number(detail.originalPrice) || sellPrice,
    options,
    totalStock,
    isSoldout: detail.inStock === false || totalStock === 0,
    sourceLeadDays: null,
    priceReliable: sellPrice > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

function getFashionplusRawOptions(optionData) {
  if (!Array.isArray(optionData) || optionData.length === 0) return null;
  const first = optionData[0] || {};
  if (Array.isArray(first.options)) return first.options;
  if (first.options && Array.isArray(first.options.sub)) return first.options.sub;
  return null;
}

async function parseFashionplusDetailForUpdate(sourceId, sourceUrl) {
  const [detail, optionData] = await Promise.all([
    getFashionplusDetail(sourceId),
    fetchFashionplusOptionData(sourceId).catch(() => null),
  ]);
  const product = parseFashionplusItem({ id: sourceId }, detail, optionData);
  if (!product) return null;
  const options = Array.isArray(product.options) ? product.options : [];
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  const sellPrice = Number(product.sellPrice) || 0;
  const rawOptions = getFashionplusRawOptions(optionData);
  const stockReal = Array.isArray(rawOptions)
    && rawOptions.length > 0
    && rawOptions.every(opt => opt && Object.prototype.hasOwnProperty.call(opt, '_stock') && Number.isFinite(Number(opt._stock)));
  return {
    sellPrice,
    originalPrice: Number(product.originalPrice) || sellPrice,
    options,
    totalStock,
    isSoldout: product.isSoldout === true || totalStock === 0,
    sourceLeadDays: null,
    priceReliable: sellPrice > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

async function parseAdidasDetailForUpdate(sourceId, sourceUrl) {
  const product = await getAdidasDetail({ modelCode: sourceId, sourceUrl });
  if (!product) return null;
  const options = Array.isArray(product.options) ? product.options : [];
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  const sellPrice = Number(product.sellPrice) || 0;
  // 재고는 availability fetch 가 성공해 모든 옵션 수량이 실제 데이터일 때만 신뢰(adidas.js __availabilityReliable).
  // 불확실하면 false → 재고 푸시 차단(오버셀링 방지). 가격은 항상 추출.
  const stockReal = product.__availabilityReliable === true;
  return {
    sellPrice,
    originalPrice: Number(product.originalPrice) || sellPrice,
    options,
    totalStock,
    isSoldout: product.isSoldout === true || totalStock === 0,
    sourceLeadDays: null,
    priceReliable: sellPrice > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

async function parseOliveyoungDetailForUpdate(sourceId, sourceUrl) {
  const detail = await getOliveyoungDetail(sourceId);
  if (!detail) return null;
  const options = getOliveyoungOptions(detail);
  const totalStock = capStock(options.reduce((sum, o) => sum + (o.isSoldout ? 0 : capStock(o.stock)), 0));
  const salePrice = Number(detail.salePrice) || Number(detail?.options?.[0]?.salePrice) || 0;
  const sellPrice = Number(detail.finalPrice) || salePrice;
  const stockReal = options.length > 0 && options.every(o => Number(o.stock) === 0);
  return {
    sellPrice,
    originalPrice: salePrice || sellPrice,
    options,
    totalStock,
    isSoldout: detail.soldOutFlag === true || totalStock === 0,
    sourceLeadDays: null,
    priceReliable: sellPrice > 0,
    stockReliable: stockReal,
    optionsReliable: stockReal,
  };
}

async function parseProduct(job) {
  const { sourceMarket, sourceId, sourceUrl } = job;
  switch (sourceMarket) {
    case 'ssg':     return parseSsgDetail(sourceId, sourceUrl, job);
    case 'lotteon': return parseLotteonDetail(sourceId, sourceUrl);
    case 'musinsa': return parseMusinsaDetail(sourceId);
    case '29cm':    return parseTwentynineCmDetail(sourceId);
    case 'wconcept': return parseWconceptDetailForUpdate(sourceId, sourceUrl);
    case 'abcmart': return parseAbcmartDetailForUpdate(sourceId);
    case 'worksout': return parseWorksoutDetailForUpdate(sourceId, sourceUrl);
    case 'grandstage': return parseGrandstageDetailForUpdate(sourceId);
    case 'gsshop': return parseGsshopDetailForUpdate(sourceId, sourceUrl);
    case 'lotteimall': return parseLotteimallDetailForUpdate(sourceId, sourceUrl);
    case 'fashionplus': return parseFashionplusDetailForUpdate(sourceId, sourceUrl);
    case 'adidas': return parseAdidasDetailForUpdate(sourceId, sourceUrl);
    case 'oliveyoung': return parseOliveyoungDetailForUpdate(sourceId, sourceUrl);
    default:
      console.warn(`[Updater] 알 수 없는 소싱처: ${sourceMarket}`);
      return null;
  }
}

// ─── 메인 업데이트 루프 ───────────────────────────────────────────────────────

// 한 마켓 jobs 처리 — parse → results/failures 버퍼 push → BATCH_SIZE flush.
// deps: { results, failures, flushBuffer, flushFailures } (호출자가 버퍼/전송 소유).
// runUpdateCycle(레거시) 과 runMarketLoop(디커플링) 양쪽이 공유.
async function processMarketBatch(marketName, marketJobs, deps) {
  const { results, failures, flushBuffer, flushFailures } = deps;
  const concurrency = Math.max(1, MARKET_UPDATE_CONCURRENCY[marketName] ?? 1);
  for (let i = 0; i < marketJobs.length; i += concurrency) {
    const chunk = marketJobs.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (job) => {
      try {
        const parsed = await parseProduct(job);
        // 2026-06-12: 출고소요일(sourceLeadDays) 크롤링 중단 — 사용자 지시. 서버 update/receive 는
        //   sourceLeadDays 가 숫자가 아니면(=null) "변동 없음"으로 lead 갱신을 스킵(update.ts:748).
        //   → 마켓 lead 는 정책(marketPolicies)에서 관리. 가격/재고/혜택가만 동기화.
        if (parsed) {
          results.push({ sourceId: job.sourceId, sourceMarket: job.sourceMarket, ...parsed, sourceLeadDays: null, sourceLeadDaysReliable: false });
          // GAP-1: 신뢰도 플래그를 텔레메트리에 전달(lost-sale 관측).
          recordMarketResult(marketName, true, { stockReliable: parsed.stockReliable, priceReliable: parsed.priceReliable });
        }
        else { failures.push(makeUpdateFailure(job, 'parser returned no result')); recordMarketResult(marketName, false); }
      } catch (err) {
        console.warn(`[Updater:${marketName}] 파싱 실패 스킵 ${job.sourceId}:`, err.message);
        failures.push(makeUpdateFailure(job, err.message));
        recordMarketResult(marketName, false);
        // GAP-2: 비SSG 마켓의 429/차단 에러도 blocks 로 분류(기존엔 SSG 만 집계).
        if (isBlockLikeError(err?.message)) recordMarketBlock(marketName, err?.message);
      }
    }));
    if (results.length >= BATCH_SIZE) await flushBuffer(false);
    if (failures.length >= BATCH_SIZE) await flushFailures(false);
    if (i + concurrency < marketJobs.length && marketName !== 'ssg') await delay(ITEM_DELAY_MS);
  }
}

let isUpdating = false;

export async function runUpdateCycle() {
  if (isUpdating) {
    console.log('[Updater] 이미 업데이트 중, 스킵');
    return;
  }
  if (isApiBackpressureActive()) {
    console.log(`[Updater] API backpressure cooldown 중 — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 후 업데이트 재시도`);
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

    // 2. 시장별로 그룹핑 → 마켓별 독립 워커 (각 소싱처 rate limit 독립)
    const byMarket = Object.fromEntries(UPDATE_MARKETS.map((market) => [market, []]));
    for (const job of jobs) {
      const sm = job.sourceMarket;
      if (byMarket[sm]) byMarket[sm].push(job);
    }
    console.log('[Updater] 시장별 분배:', Object.fromEntries(UPDATE_MARKETS.map((market) => [market, byMarket[market].length])));

    const sharedFailures = [];
    const flushFailures = async (force = false) => {
      while (sharedFailures.length >= BATCH_SIZE || (force && sharedFailures.length > 0)) {
        const batch = sharedFailures.splice(0, BATCH_SIZE);
        try {
          await sendUpdateFailures(batch);
        } catch (err) {
          console.error('[Updater] 실패 보고 전송 실패:', err.message);
        }
        if (force) break;
      }
    };

    let musinsaSourceAccountId = null;
    if (byMarket.musinsa.length > 0) {
      const cookieState = await syncAllCookies({ includeSsg: false });
      musinsaSourceAccountId = cookieState?.musinsaSourceAccountId ?? null;
      // musinsaLoggedIn=true 면(정상 로그인 또는 등급정보(mss_mac)만 만료된 session-no-grade) 업데이트를
      // 진행한다. sourceAccountId 는 null 일 수 있고 sendUpdateReceive 가 null 을 허용한다(기본/재고가는 정상 갱신).
      if (!cookieState?.musinsaLoggedIn) {
        // 진짜 로그아웃(또는 mss_mac 있으나 서버 POST 전송만 실패) — 무신사 업데이트 스킵.
        // ★ musinsaLoginWarning 스토리지는 syncAllCookies 가 이미 정확히 기록(로그아웃=경고/POST실패=보존)했다.
        //   여기서 다시 쓰면 heartbeat 로그인 신호('')를 덮어써 "무신사 로그인 미감지" 오탐을 만든다 → 쓰지 않는다.
        const warning = cookieState?.musinsaWarning || MUSINSA_LOGIN_WARNING;
        console.warn(`[Updater] ${warning} — 무신사 업데이트 ${byMarket.musinsa.length}개 스킵`);
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
          await sendUpdateReceive(batch, musinsaSourceAccountId);
        } catch (err) {
          console.error('[Updater] 전송 실패:', err.message);
          recordReceiveFailure(batch.length, err.message); // GAP-3: splice 후 유실 관측
        }
        if (force) break; // 남은 부분이 BATCH_SIZE 미만이어도 1회만 flush
      }
    };

    // 마켓별 처리는 processMarketBatch(모듈 스코프)로 위임 — runMarketLoop 와 공유.
    const batchDeps = { results: sharedResults, failures: sharedFailures, flushBuffer, flushFailures };
    await Promise.all(
      UPDATE_MARKETS.map((market) =>
        byMarket[market].length ? processMarketBatch(market, byMarket[market], batchDeps) : Promise.resolve()
      ),
    );

    // 남은 결과 최종 전송
    if (sharedResults.length > 0) {
      const finalBatch = sharedResults.splice(0, sharedResults.length);
      try {
        await sendUpdateReceive(finalBatch, musinsaSourceAccountId);
      } catch (err) {
        console.error('[Updater] 최종 전송 실패:', err.message);
        recordReceiveFailure(finalBatch.length, err.message); // GAP-3
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

// ─── 디커플링 모드: 마켓별 독립 루프 ──────────────────────────────────────────
// 각 마켓이 자기 큐를 자기 페이스로 연속 드레인. rate governor 로 안전 율속 유지,
// 공유 receiveLimiter 로 api.lonit.kr 동시 write 캡(tier-split 의 receive 경합 회귀 차단).
const marketLoopRunning = new Set();   // 같은 마켓 중복 라운드 가드
const marketLoopTimers = new Map();    // 예약된 setTimeout 핸들 (정지용)
let receiveLimiter = new Semaphore(DEFAULT_EXT_UPDATE_CONFIG.receiveCap);
const marketBuckets = new Map();       // market → TokenBucket
function bucketFor(market, cfg) {
  if (!marketBuckets.has(market)) marketBuckets.set(market, new TokenBucket(cfg.perMarketRatePerSec?.[market] ?? 0));
  return marketBuckets.get(market);
}

// config 변경 시 receiveLimiter 캡 갱신 + 전체 루프 정지(레거시 복귀용).
export function applyReceiveCap(cap) { receiveLimiter = new Semaphore(cap); }
export function stopAllMarketLoops() {
  for (const h of marketLoopTimers.values()) clearTimeout(h);
  marketLoopTimers.clear();
}

// 마켓 루프가 살아있는지 — 처리 중(running)이거나 다음 라운드 예약됨(timer).
export function isMarketLoopArmed(market) {
  return marketLoopRunning.has(market) || marketLoopTimers.has(market);
}

// 알람 워치독: 디커플링 루프는 setTimeout 체인으로 자기 재예약하는데, MV3 서비스워커가
// idle eviction 되면 그 타이머가 통째로 사라져 루프가 죽는다. background 의 2분 알람(eviction
// 에도 살아남음)이 본 함수를 호출해, 죽은(미무장) 마켓만 골라 runMarketLoop 을 재기동한다.
export function ensureMarketLoopsArmed(markets, ctx) {
  for (const market of markets) {
    if (!isMarketLoopArmed(market)) runMarketLoop(market, ctx);
  }
}

// 모든 /update/receive 는 이걸 거친다 → 동시 write 캡(api.lonit.kr 경합 방지).
async function sendReceiveLimited(items, sourceAccountId) {
  if (!items.length) return;
  const release = await receiveLimiter.acquire();
  try {
    await sendUpdateReceive(items, sourceAccountId);
  } catch (err) {
    console.error('[Updater] 전송 실패(limited):', err.message);
    recordReceiveFailure(items.length, err.message); // GAP-3: decoupled 경로 유실 관측
  } finally { release(); }
}

// 한 마켓을 자기 페이스로 연속 드레인. ctx: { cfg, isCollecting }.
export async function runMarketLoop(market, ctx) {
  const { cfg, isCollecting } = ctx;
  if (marketLoopRunning.has(market)) return;
  marketLoopRunning.add(market);
  const scheduleNext = (ms) => {
    const h = setTimeout(() => { marketLoopTimers.delete(market); runMarketLoop(market, ctx); }, ms);
    marketLoopTimers.set(market, h);
  };
  try {
    if (isCollecting()) { scheduleNext(cfg.baseIntervalMs); return; }
    if (isApiBackpressureActive()) {
      const delayMs = Math.max(cfg.baseIntervalMs, getApiBackpressureDelayMs());
      console.log(`[Updater:${market}] API backpressure cooldown 중 — ${Math.ceil(delayMs / 1000)}초 후 재시도`);
      scheduleNext(delayMs);
      return;
    }
    await bucketFor(market, cfg).take();                       // rate governor

    const data = await apiCall(`/update/pending?market=${market}`);
    const jobs = data?.jobs ?? [];
    const limit = data?.scope?.limit ?? jobs.length;
    if (jobs.length === 0) { scheduleNext(cfg.baseIntervalMs); return; }

    const results = [], failures = [];
    let sourceAccountId = null;
    if (market === 'musinsa') {
      const cookieState = await syncAllCookies({ includeSsg: false });
      sourceAccountId = cookieState?.musinsaSourceAccountId ?? null;
      // musinsaLoggedIn=true(정상 로그인 또는 등급정보만 만료된 session-no-grade) → 업데이트 진행(sourceAccountId null 허용).
      if (!cookieState?.musinsaLoggedIn) {
        // 진짜 로그아웃/POST 전송 실패 — 스킵. ★ musinsaLoginWarning 스토리지는 syncAllCookies 가 소유하므로
        //   여기서 덮어쓰지 않는다(heartbeat 로그인 신호 오염 방지 → "무신사 로그인 미감지" 오탐 차단).
        const warning = cookieState?.musinsaWarning || MUSINSA_LOGIN_WARNING;
        try {
          await sendUpdateFailures(jobs.map((j) => makeUpdateFailure(j, warning)));
        } catch (err) { console.error('[Updater:musinsa] 실패보고 전송 실패:', err.message); }
        scheduleNext(cfg.baseIntervalMs); return;
      }
    }
    const flushBuffer = async (force = false) => {
      while (results.length >= BATCH_SIZE || (force && results.length > 0)) {
        await sendReceiveLimited(results.splice(0, BATCH_SIZE), sourceAccountId);
        if (force) break;
      }
    };
    const flushFailures = async (force = false) => {
      while (failures.length >= BATCH_SIZE || (force && failures.length > 0)) {
        const batch = failures.splice(0, BATCH_SIZE);
        try { await sendUpdateFailures(batch); }
        catch (err) { console.error('[Updater] 실패보고 전송 실패:', err.message); }
        if (force) break;
      }
    };

    await processMarketBatch(market, jobs, { results, failures, flushBuffer, flushFailures });
    await flushBuffer(true);
    await flushFailures(true);

    scheduleNext(nextDelayFor(jobs.length, limit, cfg));      // 가득=즉시, 부분=짧게, 빔=baseInterval
  } catch (err) {
    console.error(`[Updater:${market}] 루프 에러:`, err.message);
    scheduleNext(cfg.baseIntervalMs);
  } finally {
    marketLoopRunning.delete(market);
  }
}
