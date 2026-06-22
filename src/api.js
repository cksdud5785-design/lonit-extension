/**
 * BulkFlow API 클라이언트
 * 확장프로그램 → 서버 통신 (인증 KEY 기반)
 */

const API_URL = 'https://api.lonit.kr'; // 프로덕션 API 고정

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomJitter(ms) {
  return Math.floor(Math.random() * Math.max(1, ms));
}

async function getApiUrl() {
  return API_URL;
}

async function getAuthKey() {
  const result = await chrome.storage.local.get(['authKey']);
  return result.authKey || '';
}

export function isGatewayBackpressureError(err) {
  const message = String(err?.message || err || '');
  const status = Number(err?.status || err?.statusCode || 0);
  return status === 502 || status === 503 || status === 504
    || /Gateway\s*Time-?out|Bad\s*Gateway|\b50[234]\b|upstream.*timeout|timeout/i.test(message);
}

const API_BACKPRESSURE_MIN_COOLDOWN_MS = 5000;
const API_BACKPRESSURE_MAX_COOLDOWN_MS = 120000;
const NON_CRITICAL_BACKPRESSURE_PATHS = [
  '/collect/pending',
  '/update/pending',
  '/heartbeat',
];
let apiBackpressureUntil = 0;
let apiBackpressureCooldownMs = 0;
let apiBackpressureLogAt = 0;
let collectPriorityUntil = 0;
let apiWriteLane = Promise.resolve();
let apiWriteLaneDepth = 0;
let lastWriteLaneLogAt = 0;

function isNonCriticalBackpressurePath(path = '') {
  return NON_CRITICAL_BACKPRESSURE_PATHS.some((prefix) => String(path || '').startsWith(prefix));
}

function isUpdateWritePath(path = '') {
  return String(path || '').startsWith('/update/receive') || String(path || '').startsWith('/update/failures');
}

function isCollectWritePath(path = '') {
  return String(path || '').startsWith('/collect/receive');
}

export function getApiBackpressureDelayMs() {
  return Math.max(0, apiBackpressureUntil - Date.now());
}

export function isApiBackpressureActive() {
  return getApiBackpressureDelayMs() > 0;
}

function markApiBackpressure(err, path = '') {
  const now = Date.now();
  const nonCritical = isNonCriticalBackpressurePath(path);
  const multiplier = nonCritical ? 1.15 : 1.8;
  const maxCooldown = nonCritical ? 30000 : API_BACKPRESSURE_MAX_COOLDOWN_MS;
  const minCooldown = nonCritical ? 5000 : API_BACKPRESSURE_MIN_COOLDOWN_MS;
  const nextCooldown = apiBackpressureCooldownMs > 0
    ? Math.min(maxCooldown, Math.floor(apiBackpressureCooldownMs * multiplier))
    : minCooldown;
  apiBackpressureCooldownMs = nextCooldown;
  apiBackpressureUntil = Math.max(apiBackpressureUntil, now + nextCooldown + randomJitter(Math.min(3000, nextCooldown)));

  if (isCollectWritePath(path)) {
    collectPriorityUntil = Math.max(collectPriorityUntil, now + Math.max(60000, nextCooldown));
  }

  if (now - apiBackpressureLogAt > 5000) {
    apiBackpressureLogAt = now;
    console.warn(
      `[Lonit] API ${nonCritical ? 'soft ' : ''}backpressure cooldown — ${Math.ceil(getApiBackpressureDelayMs() / 1000)}초 대기 (${path || 'api'}):`,
      err?.message || err,
    );
  }
}

async function deferUpdateForCollectPriority(path = '') {
  if (!isUpdateWritePath(path)) return;
  const delayMs = Math.max(0, collectPriorityUntil - Date.now());
  if (delayMs <= 0) return;
  const waitMs = Math.min(delayMs, 60000) + randomJitter(2000);
  console.warn(`[Lonit] collect write 우선권 — ${Math.ceil(waitMs / 1000)}초 후 ${path} 전송 재개`);
  await sleep(waitMs);
}

function withApiWriteLane(label, fn) {
  const run = async () => {
    const now = Date.now();
    if (now - lastWriteLaneLogAt > 10000) {
      lastWriteLaneLogAt = now;
      console.log(`[Lonit] API write lane 진입: ${label}`);
    }
    apiWriteLaneDepth += 1;
    try {
      return await fn();
    } finally {
      apiWriteLaneDepth = Math.max(0, apiWriteLaneDepth - 1);
    }
  };
  const queued = apiWriteLane.catch(() => {}).then(run);
  apiWriteLane = queued.catch(() => {});
  return queued;
}

function markApiSuccess() {
  // 성공이 확인되면 cooldown을 서서히 줄인다. 바로 0으로 만들면 회복 직후 재폭주한다.
  if (apiBackpressureCooldownMs <= 0) return;
  apiBackpressureCooldownMs = Math.floor(apiBackpressureCooldownMs * 0.65);
  if (apiBackpressureCooldownMs < API_BACKPRESSURE_MIN_COOLDOWN_MS) {
    apiBackpressureCooldownMs = 0;
  }
}

async function waitForApiBackpressure(path = '') {
  const delayMs = getApiBackpressureDelayMs();
  if (delayMs <= 0) return;
  const waitMs = delayMs + randomJitter(Math.min(2000, delayMs));
  console.warn(`[Lonit] API backpressure cooldown 중 — ${Math.ceil(waitMs / 1000)}초 후 ${path || 'api'} 재개`);
  await sleep(waitMs);
}

export async function apiCall(path, options = {}) {
  if (isNonCriticalBackpressurePath(path) && isApiBackpressureActive()) {
    const err = new Error(`API backpressure active; skipped non-critical ${path}`);
    err.skippedNonCritical = true;
    throw err;
  }
  await waitForApiBackpressure(path);
  const [apiUrl, authKey] = await Promise.all([getApiUrl(), getAuthKey()]);
  if (!authKey) throw new Error('No auth key');

  try {
    const res = await fetch(`${apiUrl}/api/v1${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Key': authKey,
        ...options.headers,
      },
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      const err = new Error(errBody.error || res.statusText || `API Error ${res.status}`);
      err.status = res.status;
      err.path = path;
      if (isGatewayBackpressureError(err)) markApiBackpressure(err, path);
      throw err;
    }
    markApiSuccess();
    return res.json();
  } catch (err) {
    if (isGatewayBackpressureError(err) && err.path !== path) {
      err.path = path;
      markApiBackpressure(err, path);
    }
    throw err;
  }
}

/**
 * 재시도 로직 포함 API 전송
 * @param {Function} fn - 실행할 async 함수
 * @param {Object} opts - { maxRetries: 10, baseDelay: 1000, label: '' }
 */
async function withRetry(fn, { maxRetries = 10, baseDelay = 1000, label = '' } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`[Lonit] ${label} 최종 실패 (${maxRetries}회 시도):`, err.message);
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);
      console.warn(`[Lonit] ${label} 실패 (${attempt}/${maxRetries}), ${delay}ms 후 재시도:`, err.message);
      await sleep(delay);
    }
  }
}

const COLLECT_RECEIVE_MIN_BATCH_SIZE = 1;
const COLLECT_RECEIVE_INITIAL_BATCH_SIZE = 6;
const COLLECT_RECEIVE_INITIAL_MAX_SAFE_BATCH_SIZE = 8;
const COLLECT_RECEIVE_HARD_MAX_BATCH_SIZE = 24;
const COLLECT_RECEIVE_GROW_AFTER_SUCCESSES = 6;
const COLLECT_RECEIVE_SAFE_CAP_GROW_AFTER_SUCCESSES = 24;
const COLLECT_RECEIVE_INITIAL_PAUSE_MS = 500;
const COLLECT_RECEIVE_MAX_PAUSE_MS = 30000;

let collectReceiveWindowSize = COLLECT_RECEIVE_INITIAL_BATCH_SIZE;
let collectReceiveMaxSafeBatchSize = COLLECT_RECEIVE_INITIAL_MAX_SAFE_BATCH_SIZE;
let collectReceiveSuccessStreak = 0;
let collectReceiveSafeCapSuccessStreak = 0;
let collectReceivePauseMs = COLLECT_RECEIVE_INITIAL_PAUSE_MS;

function clampCollectReceiveBatchSize(size) {
  const parsed = Math.trunc(Number(size) || COLLECT_RECEIVE_INITIAL_BATCH_SIZE);
  return Math.max(COLLECT_RECEIVE_MIN_BATCH_SIZE, Math.min(parsed, COLLECT_RECEIVE_HARD_MAX_BATCH_SIZE));
}

function clampCollectReceiveAdaptiveBatchSize(size) {
  const parsed = Math.trunc(Number(size) || COLLECT_RECEIVE_INITIAL_BATCH_SIZE);
  return Math.max(
    COLLECT_RECEIVE_MIN_BATCH_SIZE,
    Math.min(parsed, collectReceiveMaxSafeBatchSize, COLLECT_RECEIVE_HARD_MAX_BATCH_SIZE),
  );
}

function currentCollectReceiveBatchSize(totalLength = COLLECT_RECEIVE_INITIAL_BATCH_SIZE) {
  return Math.max(
    COLLECT_RECEIVE_MIN_BATCH_SIZE,
    Math.min(Math.max(1, Number(totalLength) || 1), collectReceiveWindowSize, collectReceiveMaxSafeBatchSize),
  );
}

function markCollectReceiveSuccess() {
  collectReceiveSuccessStreak += 1;
  collectReceiveSafeCapSuccessStreak += 1;

  if (collectReceiveSafeCapSuccessStreak >= COLLECT_RECEIVE_SAFE_CAP_GROW_AFTER_SUCCESSES) {
    collectReceiveSafeCapSuccessStreak = 0;
    if (collectReceiveMaxSafeBatchSize < COLLECT_RECEIVE_HARD_MAX_BATCH_SIZE) {
      const previousSafeCap = collectReceiveMaxSafeBatchSize;
      collectReceiveMaxSafeBatchSize = clampCollectReceiveBatchSize(collectReceiveMaxSafeBatchSize + 1);
      console.log(`[Lonit] collect 안전상한 증가: batch cap ${previousSafeCap} → ${collectReceiveMaxSafeBatchSize}`);
    }
  }

  if (collectReceiveSuccessStreak < COLLECT_RECEIVE_GROW_AFTER_SUCCESSES) return;
  collectReceiveSuccessStreak = 0;
  const previousSize = collectReceiveWindowSize;
  collectReceiveWindowSize = clampCollectReceiveAdaptiveBatchSize(collectReceiveWindowSize + 1);
  collectReceivePauseMs = Math.max(250, Math.floor(collectReceivePauseMs * 0.75));
  if (collectReceiveWindowSize !== previousSize) {
    console.log(`[Lonit] collect 전송 속도 증가: batch ${previousSize} → ${collectReceiveWindowSize}, cap=${collectReceiveMaxSafeBatchSize}, pause=${collectReceivePauseMs}ms`);
  }
}

function markCollectReceiveBackpressure(size, err) {
  const previousSize = collectReceiveWindowSize;
  const previousSafeCap = collectReceiveMaxSafeBatchSize;
  const failedSize = Math.max(COLLECT_RECEIVE_MIN_BATCH_SIZE, Number(size) || previousSize);
  const nextSafeCap = Math.max(COLLECT_RECEIVE_MIN_BATCH_SIZE, Math.floor(failedSize / 2));
  collectReceiveMaxSafeBatchSize = Math.min(collectReceiveMaxSafeBatchSize, nextSafeCap);
  const pressureSize = Math.max(COLLECT_RECEIVE_MIN_BATCH_SIZE, Math.min(previousSize, failedSize));
  collectReceiveWindowSize = clampCollectReceiveAdaptiveBatchSize(Math.floor(pressureSize / 2));
  collectReceiveSuccessStreak = 0;
  collectReceiveSafeCapSuccessStreak = 0;
  collectReceivePauseMs = Math.min(
    COLLECT_RECEIVE_MAX_PAUSE_MS,
    Math.max(6000, Math.floor((collectReceivePauseMs || COLLECT_RECEIVE_INITIAL_PAUSE_MS) * 2.4)),
  );
  markApiBackpressure(err, '/collect/receive');
  console.warn(
    `[Lonit] collect API backpressure 감지 — batch ${previousSize} → ${collectReceiveWindowSize}, cap ${previousSafeCap} → ${collectReceiveMaxSafeBatchSize}, pause=${collectReceivePauseMs}ms:`,
    err?.message || err,
  );
}

async function waitCollectReceivePace() {
  await waitForApiBackpressure('/collect/receive');
  if (collectReceivePauseMs <= 0) return;
  await sleep(collectReceivePauseMs + randomJitter(Math.min(500, collectReceivePauseMs)));
}

export function splitProductBatch(products, size = currentCollectReceiveBatchSize(Array.isArray(products) ? products.length : 1)) {
  const list = Array.isArray(products) ? products : [];
  const chunkSize = clampCollectReceiveBatchSize(size);
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

function mergeCollectResults(results) {
  return results.reduce((acc, result) => ({
    saved: acc.saved + Number(result?.saved || 0),
    updated: acc.updated + Number(result?.updated || 0),
    skipped: acc.skipped + Number(result?.skipped || 0),
    blockedCount: acc.blockedCount + Number(result?.blockedCount || 0),
    dedupBlocked: acc.dedupBlocked + Number(result?.dedupBlocked || 0),
    fuzzyShadowHits: acc.fuzzyShadowHits + Number(result?.fuzzyShadowHits || 0),
    fuzzyBlocked: acc.fuzzyBlocked + Number(result?.fuzzyBlocked || 0),
    errors: acc.errors + Number(result?.errors || 0),
    total: acc.total + Number(result?.total || 0),
  }), { saved: 0, updated: 0, skipped: 0, blockedCount: 0, dedupBlocked: 0, fuzzyShadowHits: 0, fuzzyBlocked: 0, errors: 0, total: 0 });
}

async function postProductsBatchOnce(products, jobId, sourceAccountId = null) {
  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await waitCollectReceivePace();
  try {
    return await apiCall('/collect/receive', {
      method: 'POST',
      body: JSON.stringify({
        products,
        jobId: jobId ?? null,
        sourceAccountId: sourceAccountId ?? null,
        batchId,
        refreshMedia: true,
      }),
    });
  } catch (err) {
    err.collectBatchId = batchId;
    throw err;
  }
}

async function sendProductsAdaptive(products, jobId, sourceAccountId, singleRetryCount = 0) {
  const list = Array.isArray(products) ? products : [];
  if (list.length === 0) return mergeCollectResults([]);

  const preferredSize = currentCollectReceiveBatchSize(list.length);
  if (list.length > preferredSize) {
    const results = [];
    for (const chunk of splitProductBatch(list, preferredSize)) {
      results.push(await sendProductsAdaptive(chunk, jobId, sourceAccountId));
    }
    return mergeCollectResults(results);
  }

  try {
    const result = await postProductsBatchOnce(list, jobId, sourceAccountId);
    markCollectReceiveSuccess();
    return result;
  } catch (err) {
    if (!isGatewayBackpressureError(err)) throw err;

    markCollectReceiveBackpressure(list.length, err);

    if (list.length > 1) {
      const nextSize = Math.max(COLLECT_RECEIVE_MIN_BATCH_SIZE, Math.floor(list.length / 2));
      console.warn(`[Lonit] sendProducts(${list.length}개) backpressure — ${nextSize}개 단위로 즉시 분할 재시도`);
      const results = [];
      for (const chunk of splitProductBatch(list, nextSize)) {
        results.push(await sendProductsAdaptive(chunk, jobId, sourceAccountId));
      }
      return mergeCollectResults(results);
    }

    const retryDelay = Math.max(
      5000,
      getApiBackpressureDelayMs(),
      collectReceivePauseMs,
    ) + randomJitter(3000);
    console.warn(`[Lonit] sendProducts(1개) backpressure — 서버 안정화 ${Math.ceil(retryDelay / 1000)}초 대기 후 재시도 #${singleRetryCount + 1}`);
    await sleep(retryDelay);
    return sendProductsAdaptive(list, jobId, sourceAccountId, singleRetryCount + 1);
  }
}

export async function sendProducts(products, jobId, sourceAccountId = null) {
  collectPriorityUntil = Math.max(collectPriorityUntil, Date.now() + 45000);
  return withApiWriteLane('collect/receive', () => sendProductsAdaptive(products, jobId, sourceAccountId));
}

const UPDATE_SEND_MIN_BATCH_SIZE = 1;
const UPDATE_SEND_INITIAL_BATCH_SIZE = 2;
const UPDATE_SEND_INITIAL_MAX_SAFE_BATCH_SIZE = 3;
const UPDATE_SEND_HARD_MAX_BATCH_SIZE = 12;
const UPDATE_SEND_GROW_AFTER_SUCCESSES = 8;
const UPDATE_SEND_SAFE_CAP_GROW_AFTER_SUCCESSES = 36;
const UPDATE_SEND_INITIAL_PAUSE_MS = 2000;
const UPDATE_SEND_MAX_PAUSE_MS = 60000;
console.info('[Lonit] API optimized write-lane mode — collect init=6 cap=8 hard=24 pause=500ms; update init=2 cap=3 hard=12 pause=2000ms; noncritical polling soft-skipped');
let updateSendWindowSize = UPDATE_SEND_INITIAL_BATCH_SIZE;
let updateSendMaxSafeBatchSize = UPDATE_SEND_INITIAL_MAX_SAFE_BATCH_SIZE;
let updateSendSuccessStreak = 0;
let updateSendSafeCapSuccessStreak = 0;
let updateSendPauseMs = UPDATE_SEND_INITIAL_PAUSE_MS;

function clampUpdateSendBatchSize(size) {
  const parsed = Math.trunc(Number(size) || UPDATE_SEND_INITIAL_BATCH_SIZE);
  return Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Math.min(parsed, UPDATE_SEND_HARD_MAX_BATCH_SIZE));
}

function clampUpdateSendAdaptiveBatchSize(size) {
  const parsed = Math.trunc(Number(size) || UPDATE_SEND_INITIAL_BATCH_SIZE);
  return Math.max(
    UPDATE_SEND_MIN_BATCH_SIZE,
    Math.min(parsed, updateSendMaxSafeBatchSize, UPDATE_SEND_HARD_MAX_BATCH_SIZE),
  );
}

function splitItems(items, size) {
  const list = Array.isArray(items) ? items : [];
  const chunkSize = clampUpdateSendBatchSize(size);
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) chunks.push(list.slice(i, i + chunkSize));
  return chunks;
}

function markUpdateSendSuccess(label) {
  updateSendSuccessStreak += 1;
  updateSendSafeCapSuccessStreak += 1;

  if (updateSendSafeCapSuccessStreak >= UPDATE_SEND_SAFE_CAP_GROW_AFTER_SUCCESSES) {
    updateSendSafeCapSuccessStreak = 0;
    if (updateSendMaxSafeBatchSize < UPDATE_SEND_HARD_MAX_BATCH_SIZE) {
      const previousSafeCap = updateSendMaxSafeBatchSize;
      updateSendMaxSafeBatchSize = clampUpdateSendBatchSize(updateSendMaxSafeBatchSize + 1);
      console.log(`[Lonit] ${label} 안전상한 증가: batch cap ${previousSafeCap} → ${updateSendMaxSafeBatchSize}`);
    }
  }

  if (updateSendSuccessStreak < UPDATE_SEND_GROW_AFTER_SUCCESSES) return;
  updateSendSuccessStreak = 0;
  const previousSize = updateSendWindowSize;
  updateSendWindowSize = clampUpdateSendAdaptiveBatchSize(updateSendWindowSize + 1);
  updateSendPauseMs = Math.max(1000, Math.floor(updateSendPauseMs * 0.8));
  if (updateSendWindowSize !== previousSize) {
    console.log(`[Lonit] ${label} 전송 속도 증가: batch ${previousSize} → ${updateSendWindowSize}, cap=${updateSendMaxSafeBatchSize}, pause=${updateSendPauseMs}ms`);
  }
}

function markUpdateSendBackpressure(size, err, label) {
  const previousSize = updateSendWindowSize;
  const previousSafeCap = updateSendMaxSafeBatchSize;
  const failedSize = Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Number(size) || previousSize);
  const nextSafeCap = Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Math.floor(failedSize / 2));
  updateSendMaxSafeBatchSize = Math.min(updateSendMaxSafeBatchSize, nextSafeCap);
  const pressureSize = Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Math.min(previousSize, failedSize));
  updateSendWindowSize = clampUpdateSendAdaptiveBatchSize(Math.floor(pressureSize / 2));
  updateSendSuccessStreak = 0;
  updateSendSafeCapSuccessStreak = 0;
  updateSendPauseMs = Math.min(UPDATE_SEND_MAX_PAUSE_MS, Math.max(8000, Math.floor(updateSendPauseMs * 2.5)));
  markApiBackpressure(err, label);
  console.warn(`[Lonit] ${label} backpressure — batch ${previousSize} → ${updateSendWindowSize}, cap ${previousSafeCap} → ${updateSendMaxSafeBatchSize}, pause=${updateSendPauseMs}ms:`, err?.message || err);
}

async function waitUpdateSendPace(label) {
  await waitForApiBackpressure(label);
  await sleep(updateSendPauseMs + randomJitter(Math.min(1000, updateSendPauseMs)));
}

async function sendApiItemsAdaptive(items, { path, bodyForItems, label }, singleRetryCount = 0) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;

  const preferredSize = Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Math.min(list.length, updateSendWindowSize, updateSendMaxSafeBatchSize));
  if (list.length > preferredSize) {
    let lastResult = null;
    for (const chunk of splitItems(list, preferredSize)) {
      lastResult = await sendApiItemsAdaptive(chunk, { path, bodyForItems, label });
    }
    return lastResult;
  }

  try {
    await waitUpdateSendPace(label);
    const result = await apiCall(path, { method: 'POST', body: JSON.stringify(bodyForItems(list)) });
    markUpdateSendSuccess(label);
    return result;
  } catch (err) {
    if (!isGatewayBackpressureError(err)) throw err;
    markUpdateSendBackpressure(list.length, err, label);

    if (list.length > 1) {
      const nextSize = Math.max(UPDATE_SEND_MIN_BATCH_SIZE, Math.floor(list.length / 2));
      console.warn(`[Lonit] ${label}(${list.length}개) backpressure — ${nextSize}개 단위로 즉시 분할 재시도`);
      let lastResult = null;
      for (const chunk of splitItems(list, nextSize)) {
        lastResult = await sendApiItemsAdaptive(chunk, { path, bodyForItems, label });
      }
      return lastResult;
    }

    const retryDelay = Math.max(10000, getApiBackpressureDelayMs(), updateSendPauseMs) + randomJitter(5000);
    console.warn(`[Lonit] ${label}(1개) backpressure — 서버 안정화 ${Math.ceil(retryDelay / 1000)}초 대기 후 재시도 #${singleRetryCount + 1}`);
    await sleep(retryDelay);
    return sendApiItemsAdaptive(list, { path, bodyForItems, label }, singleRetryCount + 1);
  }
}

export async function sendUpdateReceive(items, sourceAccountId = null) {
  await deferUpdateForCollectPriority('/update/receive');
  return withApiWriteLane('update/receive', () => sendApiItemsAdaptive(items, {
    path: '/update/receive',
    label: 'update/receive',
    bodyForItems: (chunk) => ({ items: chunk, sourceAccountId }),
  }));
}

export async function sendUpdateFailures(items) {
  await deferUpdateForCollectPriority('/update/failures');
  return withApiWriteLane('update/failures', () => sendApiItemsAdaptive(items, {
    path: '/update/failures',
    label: 'update/failures',
    bodyForItems: (chunk) => ({ items: chunk }),
  }));
}

export async function updateJobStatus(jobId, status) {
  return withRetry(
    () => apiCall(`/collect/jobs/${jobId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(status),
    }),
    { maxRetries: 5, baseDelay: 500, label: `updateJobStatus(${jobId})` }
  );
}
