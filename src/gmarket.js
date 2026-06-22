// 목적: 지마켓 (gmarket.co.kr) collector — Phase 0 skeleton (TODO).
//
// 권고 (recon doc 10 + spec doc 14 §1): ESM Trading API 우선, public PDP 는 fallback.
//   - 셀러승인 트랙 (사업자/마스터ID) — 사용자 결정 필요
//   - 봇 방어 벤더는 X-Px(PerimeterX/HUMAN 추정), 'Akamai' 단정은 [UNVERIFIED]
//   - JA3/JA4 위장 단독 해법 아님 — JS 텔레메트리/챌린지 쿠키 추가 검사
// auto-collect risk: 5/10. 비로그인 PDP read 자체는 가능.
// 인증: 비로그인 OK (회원가격은 로그인 — Phase 2). HIGH risk (직접 우회 시).

const TODO = '지마켓 collector 미구현 — Phase 1 PoC PR 후 활성화';

export function parseUrl(_url) { return {}; }
export async function searchProducts(_params) { throw new Error(TODO); }
export async function getDetail(_goodsCode) { throw new Error(TODO); }
export async function getOptions(_goodsCode) { throw new Error(TODO); }
export async function getLeadDays(_goodsCode) { return 2; }  // 종합몰 평균 2-4일
export async function collect(_url, _limit, _onProgress, _options) { throw new Error(TODO); }
export function cleanupGmarketTab() { /* noop */ }
