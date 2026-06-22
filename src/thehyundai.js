// 목적: 더현대 (thehyundai.com) collector — Phase 0 skeleton (TODO).
//
// 권고 (recon doc 10 + spec doc 14 §2): browser-session PoC only, blind scaling 금지.
//   - "Yeti UA 화이트리스트" 는 [UNVERIFIED] 루머로 처리 — 의존 금지
//   - 공식 B2B/파트너 API 미확인
//   - PoC stop/go 4단계: 1상품 5/5 + 24h 재캡처 + 카테고리 5건 + 사용자 검수
// auto-collect risk: 7/10 (공식 API 부재 + 백화점 UX + UA 가장 금지).
// extension-only 강제. 백그라운드 batch fetch 금지.

const TODO = '더현대 collector 미구현 — Phase 1 PoC PR 후 활성화';

export function parseUrl(_url) { return {}; }
export async function searchProducts(_params) { throw new Error(TODO); }
export async function getDetail(_slitmCd) { throw new Error(TODO); }
export async function getOptions(_slitmCd) { throw new Error(TODO); }
export async function getLeadDays(_slitmCd) { return 3; }  // 백화점 평균 2-4일
export async function collect(_url, _limit, _onProgress, _options) { throw new Error(TODO); }
export function cleanupThehyundaiTab() { /* noop */ }
