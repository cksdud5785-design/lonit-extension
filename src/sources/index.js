/**
 * 목적: 소싱처 collector 레지스트리 (Phase 0 — 9 신규 소싱처 도입 사전 작업).
 *
 * 배경: background.js 가 musinsa/ssg/lotteon 하드코드 switch + URL substring 검사 +
 * cleanup if/else 체인 3곳에 흩어져 있었다. 9 신규 소싱처 (29CM/W컨셉/더현대/ABC마트/
 * 롯데아이몰/GSshop/지마켓/올리브영/패션플러스) 추가 시 매번 3곳 동시 수정 = drift
 * 위험 (xnstar11 사고 패턴과 유사). 본 파일이 단일 진실 소스.
 *
 * 신규 소싱처 추가 절차:
 *   1. apps/extension/src/{name}.js 작성 — `collect`, `cleanup{Name}Tab` export
 *   2. 본 파일 상단 import 추가
 *   3. SOURCES 배열에 entry 1줄 추가
 *   4. background.js 변경 0 — 회귀 위험 격리
 *
 * 본 파일 추가 자체로는 런타임 동작 변경 0. background.js 가 helper 호출로 교체될 때
 * 비로소 lookup 로직이 사용됨. behavior parity 는 background.js refactor 시 검증.
 */

import { collect as collectMusinsa, cleanupMusinsaTab } from '../musinsa.js';
import { collect as collectSsg, cleanupSsgTab } from '../ssg.js';
import { collect as collectLotteon, cleanupLotteonTab } from '../lotteon.js';
// 2026-04-29: ABC마트 skeleton (Phase 0). 실 fetch 는 Phase 1 PoC PR 후.
import { collect as collectAbcmart, cleanupAbcmartTab } from '../abcmart.js';
// 2026-04-29: 8 소싱처 skeleton 추가 (Phase 0) — 모두 throw 'not implemented'.
import { collect as collectLotteimall, cleanupLotteimallTab } from '../lotteimall.js';
import { collect as collectTwentynineCm, cleanupTwentynineCmTab } from '../twentynine-cm.js';
import { collect as collectGsshop, cleanupGsshopTab } from '../gsshop.js';
import { collect as collectOliveyoung, cleanupOliveyoungTab } from '../oliveyoung.js';
import { collect as collectGmarket, cleanupGmarketTab } from '../gmarket.js';
import { collect as collectThehyundai, cleanupThehyundaiTab } from '../thehyundai.js';
import { collect as collectFashionplus, cleanupFashionplusTab } from '../fashionplus.js';
import { collect as collectWconcept, cleanupWconceptTab } from '../wconcept.js';
import { collect as collectWorksout, cleanupWorksoutTab } from '../worksout.js';
import { collect as collectAdidas, cleanupAdidasTab } from '../adidas.js';

/**
 * @typedef {Object} SourceEntry
 * @property {string} name           — canonical sourceMarket key (예: 'musinsa', '29cm')
 * @property {string[]} hostMatches  — URL substring(s) for auto-detect (e.g., 'musinsa.com')
 * @property {(job: any) => Promise<any>} collect      — 수집 함수 (useWindowCollector=true 시 호출 안 됨)
 * @property {() => void} [cleanupTab] — 임시 탭 정리 (혜택가 조회 등). 없으면 noop.
 * @property {boolean} [useWindowCollector] — true 면 background.js 가 windowCollector 경로로 실행 (더망고 패턴). 미지정 시 false — 기존 fetch path.
 * @property {string} [siteName]     — useWindowCollector=true 일 때 site-parsers/<siteName>.js 매칭. 미지정 시 name.
 */

/**
 * 등록된 소싱처 목록. 신규 entry 추가 시 본 배열에만 추가.
 *
 * 순서 의미: SOURCES[0] = primary fallback. URL/이름 추론 실패 시 사용. 현재 musinsa.
 *
 * @type {SourceEntry[]}
 */
export const SOURCES = [
  { name: 'musinsa', hostMatches: ['musinsa.com'], collect: collectMusinsa, cleanupTab: cleanupMusinsaTab },
  { name: 'ssg',     hostMatches: ['ssg.com'],     collect: collectSsg,     cleanupTab: cleanupSsgTab },
  { name: 'lotteon', hostMatches: ['lotteon.com'], collect: collectLotteon, cleanupTab: cleanupLotteonTab },
  // 2026-04-29: ABC마트 skeleton entry (Phase 0). collect 호출 시 throw 'not implemented'
  // — Phase 1 PR 에서 PoC 1 상품 검증 + rate-limiter wire 후 실 fetch 활성화.
  // 2026-04-29 Codex 검수 (PR #853): Grand Stage 의 실제 도메인은 grandstage.a-rt.com
  // (search fixture chnnlImageList 의 chnnlNo=10002 → chnnlUrl=https://grandstage.a-rt.com).
  // grandstage.co.kr 는 09 정찰 doc 의 추정 alias 였으나 live 에서는 DNS/TLS 실패 (000).
  { name: 'abcmart',     hostMatches: ['abcmart.a-rt.com', 'grandstage.a-rt.com'], collect: collectAbcmart, cleanupTab: cleanupAbcmartTab },
  // 2026-04-29: 8 소싱처 skeleton entries (Phase 0). collect 호출 시 throw — Phase 1 PoC PR 후 실 fetch 활성화.
  { name: 'lotteimall',  hostMatches: ['lotteimall.com'],                       collect: collectLotteimall,   cleanupTab: cleanupLotteimallTab },
  { name: '29cm',        hostMatches: ['29cm.co.kr'],                           collect: collectTwentynineCm, cleanupTab: cleanupTwentynineCmTab },
  { name: 'gsshop',      hostMatches: ['gsshop.com'],                           collect: collectGsshop,       cleanupTab: cleanupGsshopTab },
  { name: 'oliveyoung',  hostMatches: ['oliveyoung.co.kr'],                     collect: collectOliveyoung,   cleanupTab: cleanupOliveyoungTab },
  // 2026-05-17: gmarket → windowCollector 경로 전환 (Codex 검증 10/10 pass). 기존 src/gmarket.js TODO skeleton 은 도달 안 됨.
  // hostMatches 확장 — NOTES.md 기반 6 host (auction.co.kr / itempage.auction.co.kr / stores.auction.co.kr / gmarket.co.kr / item.gmarket.co.kr / minishop.gmarket.co.kr).
  { name: 'gmarket',
    hostMatches: ['gmarket.co.kr', 'item.gmarket.co.kr', 'minishop.gmarket.co.kr', 'auction.co.kr', 'itempage.auction.co.kr', 'stores.auction.co.kr'],
    useWindowCollector: true, siteName: 'gmarket',
    collect: async () => { throw new Error('gmarket: windowCollector 경로 — background.js 의 useWindowCollector 분기에서 처리'); },
    cleanupTab: () => {} },
  { name: 'thehyundai',  hostMatches: ['thehyundai.com', 'hi.thehyundai.com'],  collect: collectThehyundai,   cleanupTab: cleanupThehyundaiTab },
  { name: 'fashionplus', hostMatches: ['fashionplus.co.kr'],                    collect: collectFashionplus,  cleanupTab: cleanupFashionplusTab },
  { name: 'wconcept',    hostMatches: ['wconcept.co.kr'],                       collect: collectWconcept,     cleanupTab: cleanupWconceptTab },
  // 2026-05-18: worksout fetch path collector 로 전환. hostMatches 는 기존 유지.
  { name: 'worksout',    hostMatches: ['worksout.co.kr'],                       collect: collectWorksout,     cleanupTab: cleanupWorksoutTab },
  // 2026-05-18: Adidas moved from windowCollector to fetch path via /api/products/{modelCode}.
  { name: 'adidas',      hostMatches: ['adidas.co.kr', 'adidas.com'],          collect: collectAdidas,       cleanupTab: cleanupAdidasTab },
  // 2026-05-17: Nike (nike.com/kr 우선, 글로벌 nike.com fallback) windowCollector 경로 — Claude 직접 PoC (15/15 pass).
  // 더망고 site.js:2420 는 .kr 분기 없음 — Lonit 자체 JSON-LD ProductGroup 파싱.
  { name: 'nike',        hostMatches: ['nike.com'],
    useWindowCollector: true, siteName: 'nike',
    collect: async () => { throw new Error('nike: windowCollector 경로 — background.js 의 useWindowCollector 분기에서 처리'); },
    cleanupTab: () => {} },
  // 2026-05-17: folderstyle.com — 사이트 자체 서비스 종료 (2026-05-21 폐쇄, ABC마트코리아 인수). 본 작업 skip.
];

/**
 * sourceMarket 명시값으로 entry 조회.
 * @param {string|null|undefined} name
 * @returns {SourceEntry|undefined}
 */
export function getSourceByName(name) {
  if (!name) return undefined;
  return SOURCES.find((s) => s.name === name);
}

/**
 * URL 의 hostname substring 매칭으로 entry 추론.
 * @param {string|null|undefined} url
 * @returns {SourceEntry|undefined}
 */
export function detectSourceFromUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return SOURCES.find((s) => s.hostMatches.some((h) => url.includes(h)));
}

/**
 * 명시 → URL 추론 → primary fallback 순으로 entry 결정.
 * primary fallback 은 SOURCES[0] (현재 musinsa).
 *
 * @param {{ sourceMarket?: string|null, searchUrl?: string|null }} job
 * @returns {{ entry: SourceEntry, detectedEntry?: SourceEntry, resolution: 'named' | 'detected' | 'fallback' | 'mismatch' }}
 */
export function resolveSourceForJob(job) {
  const named = getSourceByName(job?.sourceMarket);
  const detected = detectSourceFromUrl(job?.searchUrl ?? '');
  if (named && detected && named.name !== detected.name) {
    return { entry: named, detectedEntry: detected, resolution: 'mismatch' };
  }
  if (named) return { entry: named, resolution: 'named' };
  if (detected) return { entry: detected, resolution: 'detected' };
  return { entry: SOURCES[0], resolution: 'fallback' };
}

export function getSourceMismatch(job) {
  const result = resolveSourceForJob(job);
  if (result.resolution !== 'mismatch') return null;
  return {
    sourceMarket: result.entry.name,
    detectedMarket: result.detectedEntry?.name || 'unknown',
    searchUrl: job?.searchUrl || '',
  };
}

export function formatSourceMismatch(mismatch) {
  if (!mismatch) return '';
  return `Selected source ${mismatch.sourceMarket} does not match URL source ${mismatch.detectedMarket}. Check the collection URL.`;
}

/**
 * 등록된 소싱처 이름 목록 (UI / 진단용).
 * @returns {string[]}
 */
export function listSourceNames() {
  return SOURCES.map((s) => s.name);
}
