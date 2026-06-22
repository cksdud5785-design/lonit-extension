// 순수 스케줄링 유닛 — 브라우저 의존 없음(단위테스트 대상).
// updater-v1226.js / background-v1226.js 가 import 해서 마켓별 디커플링 루프를 구동한다.

export const DEFAULT_EXT_UPDATE_CONFIG = {
  decoupled: false,
  receiveCap: 4,
  baseIntervalMs: 120_000,
  // 마켓별 초당 토큰(rate governor). musinsa 만 anti-bot 보수: 450/120s = 3.75/s.
  // 0 = 무제한(연속 허용). ssg 는 자체 적응형 delay 가 거버너라 0.
  perMarketRatePerSec: { musinsa: 3.75, ssg: 0, lotteon: 0, '29cm': 0, wconcept: 0, abcmart: 0 },
};

// 동시성 캡. acquire() → release 함수로 resolve.
export class Semaphore {
  constructor(max) { this.max = Math.max(1, max | 0); this.cur = 0; this.q = []; }
  acquire() {
    return new Promise((resolve) => {
      const grant = () => { this.cur++; resolve(() => this._release()); };
      if (this.cur < this.max) grant(); else this.q.push(grant);
    });
  }
  _release() { this.cur--; const next = this.q.shift(); if (next) next(); }
}

// 토큰버킷 rate governor. ratePerSec=0 → 무제한. nowFn 주입(테스트).
export class TokenBucket {
  constructor(ratePerSec, nowFn = () => Date.now()) {
    this.rate = ratePerSec; this.now = nowFn;
    this.capacity = ratePerSec > 0 ? Math.max(1, Math.ceil(ratePerSec)) : Infinity;
    this.tokens = this.capacity; this.last = nowFn();
  }
  _refill() {
    if (this.rate <= 0) return;
    const t = this.now(); const add = ((t - this.last) / 1000) * this.rate;
    if (add > 0) { this.tokens = Math.min(this.capacity, this.tokens + add); this.last = t; }
  }
  tryTake() { this._refill(); if (this.tokens >= 1) { this.tokens -= 1; return true; } return false; }
  msUntilNext() { if (this.rate <= 0) return 0; this._refill(); if (this.tokens >= 1) return 0; return Math.ceil((1 - this.tokens) / this.rate * 1000); }
  async take(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    if (this.rate <= 0) return;
    while (!this.tryTake()) await sleep(this.msUntilNext());
  }
}

// 받은 jobs 가 마켓 limit 가득 = 더 밀린 게 있음 → 즉시 재폴링.
export function shouldLoopAgain(jobsLen, marketLimit) { return jobsLen >= marketLimit; }

// 다음 라운드까지 지연: 빔=baseInterval(느린 backoff), 가득=0(즉시), 부분=짧게.
export function nextDelayFor(jobsLen, marketLimit, cfg) {
  if (jobsLen <= 0) return cfg.baseIntervalMs;
  if (jobsLen >= marketLimit) return 0;
  return Math.min(cfg.baseIntervalMs, 5_000);
}
