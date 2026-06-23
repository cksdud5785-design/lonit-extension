/**
 * BulkFlow Background Service Worker
 *
 * 더망고 방식:
 * 1. 웹 대시보드에서 수집 작업 등록
 * 2. 확장프로그램이 주기적으로 서버 폴링 → 대기중인 작업 가져옴
 * 3. 브라우저에서 수집 실행 (서버 부하 0)
 * 4. 수집 결과를 서버에 전송
 */

// 2026-04-28 Phase 0 — 소싱처 dispatch 를 sources/index.js 레지스트리로 통합.
// 신규 소싱처 (29CM/W컨셉/더현대/ABC마트/롯데아이몰/GSshop/지마켓/올리브영/패션플러스)
// 도입 시 본 파일 변경 0 — sources/index.js 의 SOURCES 배열에만 entry 추가.
import {
  getSourceByName,
  detectSourceFromUrl,
  resolveSourceForJob,
  getSourceMismatch,
  formatSourceMismatch,
} from './sources/index.js';
import { apiCall, getApiBackpressureDelayMs, isApiBackpressureActive, sendProducts, updateJobStatus } from './api.js';
import { runUpdateCycle, getIsUpdating, runMarketLoop, stopAllMarketLoops, applyReceiveCap, getUpdateStats, ensureMarketLoopsArmed } from './updater-v1226.js';
import { DEFAULT_EXT_UPDATE_CONFIG } from './update-scheduler.js';
import { syncAllCookies } from './source-account-sync.js';
// #7b: 무신사 sync push (사용자 세션/쿠키 활용 — 서버 IP 과부하 방지)
import { pushMusinsaProduct, extractMusinsaGoodsNo } from './musinsa-sync-push.js';
// 2026-05-17: 더망고-style invisible window collector (Phase 0 인프라).
// useWindowCollector=true entry 만 본 경로로 실행 — 기존 fetch path 보존.
import { collectFromUrl } from './window-collector.js';
import { SITE_PARSERS } from './site-parsers/index.js';

const DEFAULT_COLLECT_LIMIT = 10000;
const collectingMarkets = new Set(); // 소싱처별 병렬 수집 지원
let collectEnabled = false;

function shouldSkipNonCriticalApi(label = 'api') {
  if (!isApiBackpressureActive()) return false;
  console.log(`[Lonit] API backpressure cooldown 중 — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 동안 ${label} 스킵`);
  return true;
}

// ─── 업데이트 스케줄러 모드 (서버 heartbeat config 로 제어) ───────────────────
// decoupled=true 면 마켓별 독립 루프, 아니면 레거시 단일 사이클(기본). 기본 OFF.
const ALL_UPDATE_MARKETS = ['musinsa', 'ssg', 'lotteon', '29cm', 'wconcept', 'abcmart', 'worksout', 'grandstage', 'gsshop', 'lotteimall', 'fashionplus', 'adidas', 'oliveyoung'];
let extUpdateMode = 'legacy'; // 'legacy' | 'decoupled'
let decoupledCtx = null;      // 디커플링 ctx — 알람 워치독(checkPendingUpdates)이 죽은 루프 재무장에 사용.

function applyExtUpdateConfig(cfg) {
  if (cfg?.receiveCap) applyReceiveCap(cfg.receiveCap);
  const next = cfg?.decoupled ? 'decoupled' : 'legacy';
  // decoupled 인 동안은 매 heartbeat 마다 ctx 를 최신 cfg 로 갱신(워치독이 최신 설정으로 재무장).
  if (next === 'decoupled') {
    decoupledCtx = { cfg: { ...DEFAULT_EXT_UPDATE_CONFIG, ...cfg }, isCollecting: () => collectingMarkets.size > 0 };
  }
  if (next === extUpdateMode) return; // 모드 변화 없음 — 루프 기동/정지는 스킵(ctx 만 갱신됨)
  extUpdateMode = next;
  if (next === 'decoupled') {
    console.log('[Lonit] extUpdate=decoupled — 마켓별 루프 기동');
    for (const m of ALL_UPDATE_MARKETS) runMarketLoop(m, decoupledCtx);
  } else {
    console.log('[Lonit] extUpdate=legacy — 마켓별 루프 정지');
    decoupledCtx = null;
    stopAllMarketLoops();
  }
}

function resolveCollectLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_COLLECT_LIMIT;
}

// ─── 수집기 자동 선택 (sources/index.js 레지스트리 위임) ────────────────────────
// 결정 우선순위 (resolveSourceForJob):
//   1. job.sourceMarket 명시 → SOURCES.find(name 일치)
//   2. job.searchUrl URL substring → SOURCES.find(hostMatches 일치)
//   3. primary fallback (SOURCES[0] — 현재 musinsa)
function getCollector(job) {
  const { entry, resolution } = resolveSourceForJob(job);
  if (resolution === 'mismatch') {
    throw new Error(formatSourceMismatch(getSourceMismatch(job)));
  }
  if (resolution === 'fallback') {
    console.warn(
      '[BulkFlow] sourceMarket/URL 불명확, primary fallback:',
      entry.name,
      job?.searchUrl || '',
    );
  }
  return entry.collect;
}

// ─── 서버 폴링: 대기중인 수집 작업 확인 ──────
async function checkPendingJobs() {
  if (!collectEnabled) return;
  if (collectingMarkets.size > 0) {
    console.log(`[BulkFlow] 수집 ${collectingMarkets.size}건 진행 중 — 신규 작업 폴링 스킵`);
    return;
  }
  if (isApiBackpressureActive()) {
    console.log(`[BulkFlow] API backpressure cooldown 중 — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 동안 폴링 스킵`);
    return;
  }

  try {
    const data = await apiCall('/collect/pending');

    // 복수 jobs 지원 (소싱처별 동시 수집)
    const jobs = data.jobs || (data.job ? [data.job] : []);
    for (const job of jobs) {
      const mismatch = getSourceMismatch(job);
      if (mismatch) {
        const errorMessage = formatSourceMismatch(mismatch);
        console.warn('[BulkFlow] sourceMarket/URL mismatch; job rejected:', mismatch);
        await updateJobStatus(job.id, {
          status: 'failed',
          progress: 100,
          errorMessage,
        }).catch(() => {});
        continue;
      }
      const { entry } = resolveSourceForJob(job);
      const jobMarket = entry.name;
      if (collectingMarkets.has(jobMarket)) continue; // 같은 소싱처 이미 수집 중
      console.log('[BulkFlow] 대기 작업 발견:', job.id, jobMarket);
      executeJob(job); // 비동기 실행 (await 안 함 → 병렬)
    }
  } catch (err) {
    if (err?.skippedNonCritical) {
      console.log('[BulkFlow] 폴링 스킵:', err.message);
      return;
    }
    console.log('[BulkFlow] 폴링 실패:', err.message);
  }
}

// ─── 수집 실행 ────────────────────────────────
async function executeJob(job) {
  const { entry: sourceEntry } = resolveSourceForJob(job);
  const market = sourceEntry.name;
  if (collectingMarkets.has(market)) return;
  collectingMarkets.add(market);

  // 배지 표시
  chrome.action.setBadgeText({ text: '...' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });

  // 2026-05-17 Phase 0: useWindowCollector entry 는 더망고-style invisible window 경로로 실행.
  // 기존 fetch path 는 변경 없음 (useWindowCollector 미지정/false 시 그대로 collector(...)).
  if (sourceEntry.useWindowCollector) {
    await executeWindowCollectorJob(job, sourceEntry, market);
    return;
  }

  const collector = getCollector(job);
  const marketLabel = market;
  let sourceAccountId = null;
  let loginWarning = null;

  try {
    // 무신사 쿠키를 서버에 동기화 (등급 혜택가 조회용)
    if (marketLabel === 'musinsa') {
      const cookieState = await syncAllCookies();
      if (cookieState?.musinsaLoggedIn && cookieState?.musinsaSourceAccountId) {
        sourceAccountId = cookieState.musinsaSourceAccountId;
      } else {
        loginWarning = cookieState?.musinsaWarning || '무신사 로그인이 되어있지 않습니다. 로그인 혜택가를 가져올 수 없습니다.';
      }
    }

    // 서버에 시작 알림
    await updateJobStatus(job.id, {
      status: 'running',
      progress: 0,
      errorMessage: loginWarning,
    }).catch(() => {});

    // 수집 실행 (사용자 브라우저에서)
    // 혜택가 설정 로드
    let collectBenefit = false;
    let marketBenefitSettings = null;
    try {
      const benefitSettings = await apiCall('/benefit-settings');
      marketBenefitSettings = benefitSettings?.[marketLabel] || null;
      if (marketBenefitSettings) {
        collectBenefit = !!(
          marketBenefitSettings.coupon
          || marketBenefitSettings.ownPoint
          || marketBenefitSettings.point
          || marketBenefitSettings.gradeDiscount
          || marketBenefitSettings.couponApply
          || marketBenefitSettings.pointUse
          || marketBenefitSettings.prePointDiscount
        );
      }
    } catch (e) { console.log('[BulkFlow] 혜택가 설정 로드 실패:', e.message); }
    console.log('[BulkFlow] 혜택가 수집:', collectBenefit, '마켓:', marketLabel);

    const collectLimit = resolveCollectLimit(job.collectLimit);
    console.log('[BulkFlow] 수집 시작:', job.searchUrl, '마켓:', marketLabel, '제한:', collectLimit);
    let lastReportedProgress = -1;
    let stopRequested = false;
    let streamSent = 0; // 스트리밍 전송 카운트

    // 2026-05-17 사용자 신고 "수집중 중지 처리도 안되" — cancel 응답성 개선.
    //   기존: onProgress callback 안에서 progress%10===0 일 때만 cancel API poll → 큰 수집에서
    //   stop 클릭 후 수십 초~수 분 대기. AbortController + 15초 setInterval poll 추가.
    const abortController = new AbortController();
    const cancelPoll = setInterval(async () => {
      try {
        if (shouldSkipNonCriticalApi('중지요청 확인')) return;
        const jobStatus = await apiCall(`/collect-manage/jobs/${job.id}`);
        if (jobStatus?.job?.cancelRequestedAt || jobStatus?.job?.cancel_requested_at) {
          if (!stopRequested) {
            console.log('[BulkFlow] 중지 요청 감지 — abort signal');
            stopRequested = true;
            abortController.abort();
          }
        }
      } catch {}
    }, 15_000);

    let persistedSaved = 0;
    let persistedUpdated = 0;
    let persistedSkipped = 0;
    let persistedBlocked = 0;
    let persistedErrors = 0;
    let streamQueued = 0;
    const uploadQueue = [];
    let uploadDrainPromise = null;
    let uploadDrainActive = false;

    const pushBatch = async (batch) => {
      const result = await sendProducts(batch, job.id, sourceAccountId);
      streamSent += batch.length;
      persistedSaved += Number(result?.saved || 0);
      persistedUpdated += Number(result?.updated || 0);
      persistedSkipped += Number(result?.skipped || 0);
      persistedBlocked += Number(result?.blockedCount ?? 0);
      persistedErrors += Number(result?.errors || 0);
      if (!shouldSkipNonCriticalApi('수집 카운트 상태 업데이트')) {
        await updateJobStatus(job.id, {
          progress: Math.max(lastReportedProgress, 0),
          collectedCount: persistedSaved + persistedUpdated,
          newCount: persistedSaved,
          updatedCount: persistedUpdated,
          skippedCount: persistedSkipped,
          blockedCount: persistedBlocked,
          errorCount: persistedErrors,
        }).catch(() => {});
      }
      console.log(
        `[BulkFlow] 서버 반영: 저장 ${persistedSaved + persistedUpdated}개, 금지 ${persistedBlocked}개, 오류 ${persistedErrors}개`
      );
      return result;
    };

    const drainUploadQueue = () => {
      if (uploadDrainActive && uploadDrainPromise) return uploadDrainPromise;
      uploadDrainActive = true;
      uploadDrainPromise = (async () => {
        while (uploadQueue.length > 0) {
          const batch = uploadQueue[0];
          try {
            await pushBatch(batch);
            uploadQueue.shift();
            console.log(`[BulkFlow] 업로드 queue 전송: ${batch.length}개 (전송누적: ${streamSent}, 대기배치: ${uploadQueue.length})`);
          } catch (err) {
            // Gateway/backpressure는 sendProducts 내부에서 계속 재시도한다. 여기까지 온 에러는
            // 비게이트웨이 예외이므로 queue 전체를 막지 않도록 해당 batch만 내려놓는다.
            uploadQueue.shift();
            persistedErrors += batch.length;
            console.error('[BulkFlow] 업로드 queue 전송 실패:', err.message);
          }
        }
      })().finally(() => {
        uploadDrainActive = false;
        uploadDrainPromise = null;
        if (uploadQueue.length > 0) drainUploadQueue();
      });
      return uploadDrainPromise;
    };

    const enqueueBatch = async (batch) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      uploadQueue.push(batch);
      streamQueued += batch.length;
      chrome.action.setBadgeText({ text: String(streamQueued) });
      if (uploadQueue.length === 1) {
        console.log(`[BulkFlow] 업로드 queue 시작: ${batch.length}개 (대기배치: ${uploadQueue.length})`);
      }
      const drain = drainUploadQueue();
      if (uploadQueue.length >= 80) {
        console.warn(`[BulkFlow] 업로드 queue 과다(${uploadQueue.length}배치) — 서버 전송을 잠시 따라잡는 중`);
        await drain;
      }
    };

    const waitForUploadQueueIdle = async () => {
      while (uploadDrainPromise || uploadQueue.length > 0) {
        if (uploadDrainPromise) await uploadDrainPromise;
        else if (uploadQueue.length > 0) await drainUploadQueue();
      }
    };

    const products = await collector(
      job.searchUrl || '',
      collectLimit,
      async (progress, found, collected, message) => {
        chrome.action.setBadgeText({ text: String(streamSent || collected || found) });

        // 서버에 진행 상태 업데이트: 5% 단위 또는 최초 호출
        if (progress !== lastReportedProgress && (progress % 5 === 0 || lastReportedProgress === -1)) {
          lastReportedProgress = progress;
          if (!shouldSkipNonCriticalApi('수집 진행률 업데이트')) {
            await updateJobStatus(job.id, { progress }).catch(() => {});
          }

          // 중지 요청 확인 (10% 단위)
          if (progress % 10 === 0 && progress > 0 && !shouldSkipNonCriticalApi('중지요청 확인')) {
            try {
              const jobStatus = await apiCall(`/collect-manage/jobs/${job.id}`);
              if (jobStatus?.job?.cancelRequestedAt || jobStatus?.job?.cancel_requested_at) {
                stopRequested = true;
                throw new Error('STOP_REQUESTED');
              }
            } catch (e) {
              if (e.message === 'STOP_REQUESTED') throw e;
            }
          }
        }
      },
      {
        collectBenefit,
        signal: abortController.signal,
        // 스트리밍 전송: 수집 루프와 서버 업로드를 분리한다.
        // 서버가 502/504여도 수집 자체를 멈추지 않고 queue drain이 뒤에서 따라간다.
        onBatch: async (batch) => {
          await enqueueBatch(batch);
          console.log(`[BulkFlow] 스트리밍 queue 적재: ${batch.length}개 (수집누적: ${streamQueued}, 대기배치: ${uploadQueue.length})`);
        },
      }
    ).catch(e => {
      if (e.message === 'STOP_REQUESTED' || stopRequested || abortController.signal.aborted) return [];
      throw e;
    }).finally(() => {
      clearInterval(cancelPoll);
    });

    // onBatch로 전송 안 된 나머지가 있으면 후처리 (무신사/SSG는 아직 onBatch 미지원)
    if (streamQueued === 0 && products.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        await enqueueBatch(batch);
      }
    }

    await waitForUploadQueueIdle();

    // 완료 또는 중지
    if (stopRequested) {
      await updateJobStatus(job.id, {
        status: 'stopped',
        completedAt: new Date().toISOString(),
        progress: Math.max(lastReportedProgress, 0),
        collectedCount: persistedSaved + persistedUpdated,
        newCount: persistedSaved,
        updatedCount: persistedUpdated,
        skippedCount: persistedSkipped,
        blockedCount: persistedBlocked,
        errorCount: persistedErrors,
      }).catch(() => {});
      chrome.action.setBadgeText({ text: '⏹' });
      chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
      console.log(`[BulkFlow] 작업 중지: ${streamSent}개 전송 (마켓: ${marketLabel})`);
    } else {
      await updateJobStatus(job.id, {
        status: 'completed',
        progress: 100,
        collectedCount: persistedSaved + persistedUpdated,
        newCount: persistedSaved,
        updatedCount: persistedUpdated,
        skippedCount: persistedSkipped,
        blockedCount: persistedBlocked,
        errorCount: persistedErrors,
      }).catch(() => {});
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
      console.log(
        `[BulkFlow] 작업 완료: 저장 ${persistedSaved + persistedUpdated}개, 금지 ${persistedBlocked}개, 오류 ${persistedErrors}개 (마켓: ${marketLabel})`
      );
    }
  } catch (err) {
    console.error('[BulkFlow] 수집 실패:', err.message);

    await updateJobStatus(job.id, { status: 'failed', errorMessage: err.message }).catch(() => {});

    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  } finally {
    collectingMarkets.delete(market);
    // 혜택가 탭 정리 — sources/index.js 의 cleanupTab hook 통일.
    try {
      const sourceEntry = getSourceByName(market);
      if (sourceEntry?.cleanupTab) {
        sourceEntry.cleanupTab();
      }
    } catch {}
  }
}

// ─── windowCollector 경로 (Phase 0 신규) ─────────────────────────────────────
// 더망고-style invisible window 수집. useWindowCollector=true entry 만 본 경로.
// 기존 fetch path (executeJob 의 나머지) 와 완전 분리 — 회귀 위험 격리.
async function executeWindowCollectorJob(job, sourceEntry, market) {
  const siteName = sourceEntry.siteName || sourceEntry.name;
  console.log('[Lonit] windowCollector 경로:', siteName, job.searchUrl);
  try {
    await updateJobStatus(job.id, { status: 'running', progress: 0 }).catch(() => {});

    const collectLimit = resolveCollectLimit(job.collectLimit);
    const result = await collectFromUrl(job.searchUrl || '', siteName, { timeoutMs: 30_000, collectLimit });
    if (result.status !== 'ok') {
      throw new Error(
        `window collector status=${result.status}` + (result.error ? `: ${result.error}` : ''),
      );
    }

    const parser = SITE_PARSERS[siteName];
    if (!parser) throw new Error(`no parser for site: ${siteName}`);

    const rawProducts = await parser.parse(result.html, job.searchUrl || '', result.extraHtml, result.plpItems);
    // collectLimit 강제 적용 — PLP fallback 의 plpItems 가 페이지 product card 전체 반환할 수 있음.
    const products = rawProducts.slice(0, collectLimit);
    console.log(`[Lonit] windowCollector parse 결과: ${products.length} products (raw=${rawProducts.length}, limit=${collectLimit})`);

    let persistedSaved = 0;
    let persistedUpdated = 0;
    let persistedErrors = 0;
    const batchSize = 50;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      try {
        const res = await sendProducts(batch, job.id, null);
        persistedSaved += Number(res?.saved || 0);
        persistedUpdated += Number(res?.updated || 0);
      } catch (e) {
        persistedErrors += batch.length;
        console.error('[Lonit] windowCollector sendProducts 실패:', e.message);
      }
    }

    await updateJobStatus(job.id, {
      status: 'completed',
      progress: 100,
      collectedCount: persistedSaved + persistedUpdated,
      newCount: persistedSaved,
      updatedCount: persistedUpdated,
      errorCount: persistedErrors,
    }).catch(() => {});

    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
    console.log(
      `[Lonit] windowCollector 완료: ${persistedSaved + persistedUpdated}개 저장 (마켓: ${market})`,
    );
  } catch (err) {
    console.error('[Lonit] windowCollector 실패:', err.message);
    await updateJobStatus(job.id, { status: 'failed', errorMessage: err.message }).catch(() => {});
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  } finally {
    collectingMarkets.delete(market);
  }
}

/** URL에서 마켓 이름 감지 — sources/index.js detectSourceFromUrl 위임. */
function detectMarket(url = '') {
  return detectSourceFromUrl(url)?.name || 'unknown';
}

// ─── 메시지 핸들러 (popup → background) ──────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ENABLE_COLLECT') {
    collectEnabled = true;
    startPolling();
    sendResponse({ ok: true });
  }
  if (msg.type === 'DISABLE_COLLECT') {
    collectEnabled = false;
    stopPolling();
    sendResponse({ ok: true });
  }
  if (msg.type === 'CONFIG_UPDATED') {
    checkPendingJobs();
    sendResponse({ ok: true });
  }
  if (msg.type === 'MANUAL_SYNC') {
    checkPendingJobs().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true; // async
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({ isCollecting: collectingMarkets.size > 0, collectEnabled, collectingMarkets: [...collectingMarkets] });
  }
  // 2026-06-12: 업데이트 처리량/차단/적응 딜레이 모니터링 (popup·콘솔에서 조회).
  if (msg.type === 'GET_UPDATE_STATS') {
    sendResponse(getUpdateStats());
  }
  // #7b: 현재 탭의 무신사 상품 페이지를 즉시 스크랩 → 서버 push
  if (msg.type === 'MUSINSA_PUSH_CURRENT') {
    const { url } = msg;
    const goodsNo = extractMusinsaGoodsNo(url || '');
    if (!goodsNo) {
      sendResponse({ ok: false, error: '무신사 상품 페이지가 아닙니다' });
      return true;
    }
    pushMusinsaProduct(goodsNo)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }
  return true;
});

// ─── 폴링 (chrome.alarms) ────────────────────
function startPolling() {
  chrome.alarms.create('bulkflow-poll', { periodInMinutes: 0.5 }); // 30초마다
  console.log('[BulkFlow] 폴링 시작');
}

function stopPolling() {
  chrome.alarms.clear('bulkflow-poll');
  console.log('[BulkFlow] 폴링 중지');
}

async function restoreCollectState(reason = 'startup') {
  try {
    const result = await chrome.storage.local.get(['collectEnabled']);
    collectEnabled = result.collectEnabled ?? false;
    console.log(`[BulkFlow] 수집 상태 복원(${reason}):`, collectEnabled);

    if (collectEnabled) {
      startPolling();
      checkPendingJobs().catch((err) => {
        console.log('[BulkFlow] 초기 폴링 실패:', err.message);
      });
      return;
    }

    stopPolling();
  } catch (err) {
    console.error('[BulkFlow] 수집 상태 복원 실패:', err.message);
  }
}

// ─── 업데이트 폴링 (5분마다) ──────────────────
async function checkPendingUpdates() {
  // 디커플링 모드에선 마켓별 루프가 담당 — 레거시 사이클 스킵(중복 방지).
  // 단, SW eviction 으로 setTimeout 루프가 끊겼을 수 있으므로, eviction 에도 살아남는 이 2분
  // 알람을 워치독으로 써서 죽은 마켓 루프를 재무장한다(무신사 등 장시간 stale 자가복구).
  if (extUpdateMode === 'decoupled') {
    if (decoupledCtx) ensureMarketLoopsArmed(ALL_UPDATE_MARKETS, decoupledCtx);
    return;
  }
  // 수집 중일 때는 업데이트 스킵 (충돌 방지 — 탭/네트워크 경합)
  if (collectingMarkets.size > 0) {
    console.log('[Lonit] 수집 중 — 업데이트 스킵');
    return;
  }
  // 이미 업데이트 중이면 스킵
  if (getIsUpdating()) {
    console.log('[Lonit] 이미 업데이트 중 — 스킵');
    return;
  }
  if (isApiBackpressureActive()) {
    console.log(`[Lonit] API backpressure cooldown 중 — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 동안 업데이트 폴링 스킵`);
    return;
  }
  try {
    await runUpdateCycle();
  } catch (err) {
    console.error('[Lonit] 업데이트 폴링 에러:', err.message);
  }
}

async function sendHeartbeat(reason = 'alarm') {
  try {
    if (isApiBackpressureActive()) {
      console.log(`[Lonit] API backpressure cooldown 중 — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 동안 heartbeat 스킵`);
      return;
    }
    const { authKey, musinsaLoginWarning } = await chrome.storage.local.get(['authKey', 'musinsaLoginWarning']);
    if (!authKey) return;
    const resp = await apiCall('/update/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        reason,
        updating: getIsUpdating(),
        collectEnabled,
        collectingMarkets: [...collectingMarkets],
        // 무신사 로그인 상태 — syncAllCookies 가 storage 에 기록(성공 시 '', 실패 시 경고문).
        // 서버가 대시보드 "무신사 로그인 미감지" 경고에 사용.
        musinsaLoggedIn: !musinsaLoginWarning,
      }),
    });
    // 서버 rollout/튜닝 config 적용 (zip 재빌드 없이 토글). 캐시해 다음 부팅까지 유지.
    if (resp?.extUpdate) {
      await chrome.storage.local.set({ extUpdateConfig: resp.extUpdate });
      applyExtUpdateConfig(resp.extUpdate);
    }
  } catch (err) {
    console.log('[Lonit] heartbeat 실패:', err.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bulkflow-poll') {
    checkPendingJobs();
  }
  if (alarm.name === 'lonit-cookie-sync') {
    syncAllCookies();
  }
  if (alarm.name === 'lonit-update-check') {
    checkPendingUpdates();
  }
  if (alarm.name === 'lonit-heartbeat') {
    sendHeartbeat('alarm');
  }
});

// 2026-06-23: 무신사 재로그인 즉시 재감지 — 세션 쿠키(app_atk/app_rtk/mss_mac) 변경 시
//   syncAllCookies 를 8초 debounce 로 재실행. 기존엔 'lonit-cookie-sync' 60분 알람/재시작
//   때만 재검사 → 재로그인해도 최대 60분 "무신사 로그인 미감지" 잔존(특히 mss_mac 단명).
//   재동기화 직후 heartbeat 도 즉시 보내 대시보드 explicit musinsaLoggedIn 을 갱신한다.
let _musinsaCookieSyncTimer = null;
chrome.cookies.onChanged.addListener((info) => {
  const ck = info?.cookie;
  if (!ck || !ck.domain || !ck.domain.includes('musinsa.com')) return;
  if (!['app_atk', 'app_rtk', 'mss_mac'].includes(ck.name)) return;
  if (_musinsaCookieSyncTimer) clearTimeout(_musinsaCookieSyncTimer);
  _musinsaCookieSyncTimer = setTimeout(() => {
    _musinsaCookieSyncTimer = null;
    syncAllCookies()
      .then(() => sendHeartbeat('musinsa-cookie-change'))
      .catch((err) => console.log('[Lonit] musinsa 쿠키변경 재동기화 실패:', err?.message));
  }, 8000);
});

// ─── D1 (2026-05-18): Activation burst — chrome 켜자마자 즉시 stale catch-up ──
// 기존 alarm 'lonit-update-check' (2분 주기) 으로는 사용자가 chrome 열고
// 첫 polling 까지 최대 2분 대기. activation 시점에 즉시 1회 trigger 해 wait 제거.
// 5분 cooldown 으로 service worker 빈번 wake/sleep 시 burst 남발 방지.
async function triggerActivationBurst(reason) {
  try {
    const STORAGE_KEY = 'lastActivationBurst';
    const COOLDOWN_MS = 5 * 60 * 1000; // 5분
    const { [STORAGE_KEY]: lastBurst = 0 } = await chrome.storage.local.get(STORAGE_KEY);
    const elapsed = Date.now() - lastBurst;
    if (elapsed < COOLDOWN_MS) {
      console.log(`[Lonit] activation burst skip (${reason}): cooldown ${Math.round((COOLDOWN_MS - elapsed) / 1000)}s 남음`);
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: Date.now() });
    console.log(`[Lonit] activation burst (${reason}): 즉시 catch-up 시도`);
    // checkPendingUpdates 는 collectingMarkets/isUpdating 검사 내장 — 충돌 안전.
    await checkPendingUpdates();
  } catch (err) {
    console.log(`[Lonit] activation burst 실패 (${reason}):`, err.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  restoreCollectState('installed');
  sendHeartbeat('installed');
  triggerActivationBurst('installed');
});

chrome.runtime.onStartup.addListener(() => {
  restoreCollectState('startup');
  sendHeartbeat('startup');
  triggerActivationBurst('startup');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.collectEnabled) return;

  collectEnabled = changes.collectEnabled.newValue ?? false;
  console.log('[BulkFlow] collectEnabled 변경 감지:', collectEnabled);

  if (collectEnabled) {
    startPolling();
    checkPendingJobs().catch((err) => {
      console.log('[BulkFlow] storage 변경 후 폴링 실패:', err.message);
    });
    return;
  }

  stopPolling();
});

// ─── 초기화 ──────────────────────────────────
restoreCollectState('load');

// 캐시된 extUpdate config 즉시 적용 (heartbeat 도착 전 부팅 race 방지 — 직전 모드 유지).
chrome.storage.local.get(['extUpdateConfig']).then(({ extUpdateConfig }) => {
  if (extUpdateConfig) applyExtUpdateConfig(extUpdateConfig);
}).catch(() => {});

// 확장프로그램 시작 시 + 1시간마다 쿠키 동기화
syncAllCookies();
chrome.alarms.create('lonit-cookie-sync', { periodInMinutes: 60 });

// 업데이트 폴링: 2분마다 가격/재고 업데이트 (수집 중이 아닐 때만 실행)
// 2026-04-17: 5분 → 2분 단축 + /update/pending limit 50 → 200 과 함께 stale
// 해소 속도 3배 이상 향상 (시간당 처리량 600 → 6,000).
chrome.alarms.create('lonit-update-check', { periodInMinutes: 2 });
// 2026-06-02 롤백 정리: fast/slow 분리 실험(역효과 확인)에서 만든 알람 잔재 제거.
try { chrome.alarms.clear('lonit-update-check-slow'); } catch (e) {}
chrome.alarms.create('lonit-heartbeat', { periodInMinutes: 5 });
sendHeartbeat('load');
console.log('[Lonit] 업데이트 폴링 등록 (2분 간격, Musinsa 최대 450개)');
console.log('[Lonit] 확장 로드됨 — manifest v1.7.17 (관측성: 마켓별 재고미신뢰/lost-sale·차단사유·전송실패 텔레메트리 popup)');

// 2026-06-08: 무신사 자동송장입력 워커 (격리 모듈). 기존 수집 로직과 독립 — alarm/메시지 type 별개.
import './auto-invoice/worker.js';
