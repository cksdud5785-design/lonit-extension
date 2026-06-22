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
import { apiCall, sendProducts, updateJobStatus } from './api.js';
import { runUpdateCycle, getIsUpdating } from './updater.js';
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
    let persistedSaved = 0;
    let persistedUpdated = 0;
    let persistedSkipped = 0;
    let persistedBlocked = 0;
    let persistedErrors = 0;

    const pushBatch = async (batch) => {
      const result = await sendProducts(batch, job.id, sourceAccountId);
      streamSent += batch.length;
      persistedSaved += Number(result?.saved || 0);
      persistedUpdated += Number(result?.updated || 0);
      persistedSkipped += Number(result?.skipped || 0);
      persistedBlocked += Number(result?.blockedCount ?? 0);
      persistedErrors += Number(result?.errors || 0);
      await updateJobStatus(job.id, {
        progress: Math.max(lastReportedProgress, 0),
        collectedCount: persistedSaved + persistedUpdated,
        newCount: persistedSaved,
        updatedCount: persistedUpdated,
        skippedCount: persistedSkipped,
        blockedCount: persistedBlocked,
        errorCount: persistedErrors,
      }).catch(() => {});
      console.log(
        `[BulkFlow] 서버 반영: 저장 ${persistedSaved + persistedUpdated}개, 금지 ${persistedBlocked}개, 오류 ${persistedErrors}개`
      );
      return result;
    };

    const products = await collector(
      job.searchUrl || '',
      collectLimit,
      async (progress, found, collected, message) => {
        chrome.action.setBadgeText({ text: String(streamSent || collected || found) });

        // 서버에 진행 상태 업데이트: 5% 단위 또는 최초 호출
        if (progress !== lastReportedProgress && (progress % 5 === 0 || lastReportedProgress === -1)) {
          lastReportedProgress = progress;
          await updateJobStatus(job.id, { progress }).catch(() => {});

          // 중지 요청 확인 (10% 단위)
          if (progress % 10 === 0 && progress > 0) {
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
        // 스트리밍 전송: 50개씩 수집 즉시 서버에 전송 (서비스워커 crash 안전)
        onBatch: async (batch) => {
          try {
            await pushBatch(batch);
            console.log(`[BulkFlow] 스트리밍 전송: ${batch.length}개 (누적: ${streamSent})`);
          } catch (err) {
            console.error('[BulkFlow] 스트리밍 전송 실패:', err.message);
          }
        },
      }
    ).catch(e => {
      if (e.message === 'STOP_REQUESTED' || stopRequested) return []; // 중지 시 빈 배열
      throw e;
    });

    // onBatch로 전송 안 된 나머지가 있으면 후처리 (무신사/SSG는 아직 onBatch 미지원)
    if (streamSent === 0 && products.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        try {
          await pushBatch(batch);
        } catch (err) {
          console.error('[BulkFlow] 전송 실패:', err.message);
        }
      }
    }

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
    const products = rawProducts.slice(0, collectLimit);
    console.log(`[Lonit] windowCollector parse 결과: ${products.length} products (raw=${rawProducts.length}, limit=${collectLimit})`);

    // 50개씩 batch — 기존 fetch path 의 pushBatch 패턴 mirror
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
  try {
    await runUpdateCycle();
  } catch (err) {
    console.error('[Lonit] 업데이트 폴링 에러:', err.message);
  }
}

async function sendHeartbeat(reason = 'alarm') {
  try {
    const { authKey } = await chrome.storage.local.get(['authKey']);
    if (!authKey) return;
    await apiCall('/update/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        version: chrome.runtime.getManifest().version,
        reason,
        updating: getIsUpdating(),
        collectEnabled,
        collectingMarkets: [...collectingMarkets],
      }),
    });
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

chrome.runtime.onInstalled.addListener(() => {
  restoreCollectState('installed');
  sendHeartbeat('installed');
});

chrome.runtime.onStartup.addListener(() => {
  restoreCollectState('startup');
  sendHeartbeat('startup');
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

// 확장프로그램 시작 시 + 1시간마다 쿠키 동기화
syncAllCookies();
chrome.alarms.create('lonit-cookie-sync', { periodInMinutes: 60 });

// 업데이트 폴링: 2분마다 가격/재고 업데이트 (수집 중이 아닐 때만 실행)
// 2026-04-17: 5분 → 2분 단축 + /update/pending limit 50 → 200 과 함께 stale
// 해소 속도 3배 이상 향상 (시간당 처리량 600 → 6,000).
chrome.alarms.create('lonit-update-check', { periodInMinutes: 2 });
chrome.alarms.create('lonit-heartbeat', { periodInMinutes: 5 });
sendHeartbeat('load');
console.log('[Lonit] 업데이트 폴링 등록 (2분 간격, Musinsa 최대 450개)');
