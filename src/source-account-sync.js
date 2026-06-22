import { apiCall } from './api.js';

export const MUSINSA_LOGIN_WARNING = '무신사 로그인이 되어있지 않습니다. 로그인 혜택가를 가져올 수 없습니다.';
export const MUSINSA_NO_COOKIE_WARNING = '무신사 쿠키를 찾을 수 없습니다. 무신사 로그인 후 다시 시도해주세요.';
// app 세션은 살아있으나 mss_mac(회원정보 JWT)만 만료/삭제된 상태용 안내. "로그인 안 됨"이 아님.
export const MUSINSA_GRADE_STALE_WARNING = '무신사 회원 등급 정보가 만료되었습니다. 무신사(musinsa.com)에 다시 접속하면 자동 갱신됩니다 — 그 전까지 등급 혜택가가 일시적으로 빠질 수 있습니다.';

// 무신사 로그인 세션 쿠키. 서버 musinsa-auth.ts 의 REQUIRED_COOKIES(app_atk/app_rtk/mss_mac)와 정렬.
//   app_atk(액세스)/app_rtk(리프레시) = 세션 그 자체. mss_mac(회원정보 JWT) = 등급/혜택가 산출.
// ★ mss_mac 은 만료가 짧아 app 토큰이 유효한데도 먼저 사라질 수 있다. 과거엔 mss_mac '단독'
//   부재를 곧 로그아웃으로 판정해 "로그인했는데 로그인 안 됨" 오탐을 냈다(2026-06-20 신고).
export const MUSINSA_SESSION_COOKIES = ['app_atk', 'app_rtk', 'mss_mac'];

/**
 * 캡처된 쿠키 이름들로 무신사 로그인 상태를 분류한다 (순수 함수, 단위테스트 대상).
 * @param {Iterable<string>} cookieNames 캡처된 무신사 쿠키 이름들
 * @returns {{ status:'logged-in'|'session-no-grade'|'logged-out'|'no-cookies', hasMssMac:boolean, hasSession:boolean, warning:(string|null) }}
 */
export function classifyMusinsaLogin(cookieNames) {
  const names = new Set(cookieNames);
  if (names.size === 0) {
    return { status: 'no-cookies', hasMssMac: false, hasSession: false, warning: MUSINSA_NO_COOKIE_WARNING };
  }
  const hasMssMac = names.has('mss_mac');
  const hasSession = MUSINSA_SESSION_COOKIES.some((n) => names.has(n));
  if (hasMssMac) {
    // 정상: 회원정보 JWT 존재 → 서버가 등급/혜택가까지 산출 가능.
    return { status: 'logged-in', hasMssMac: true, hasSession: true, warning: null };
  }
  if (hasSession) {
    // app 토큰은 있는데 mss_mac 만 부재 — 로그인은 유효, 등급정보만 갱신 필요(오탐 금지).
    return { status: 'session-no-grade', hasMssMac: false, hasSession: true, warning: MUSINSA_GRADE_STALE_WARNING };
  }
  // 무신사 도메인 쿠키는 있으나(_ga 등) 세션 쿠키가 전무 — 진짜 로그아웃.
  return { status: 'logged-out', hasMssMac: false, hasSession: false, warning: MUSINSA_LOGIN_WARNING };
}

async function getAllCookiesSafe(query) {
  try {
    const r = await chrome.cookies.getAll(query);
    return Array.isArray(r) ? r : [];
  } catch {
    return []; // 구버전 Chrome 의 partitionKey 미지원 등 — 무해하게 스킵
  }
}

/**
 * 무신사 쿠키를 가능한 모든 경로로 합집합 수집한다.
 *  - getAll 기본값은 비파티션 쿠키만 반환(CHIPS 누락)이라 partitionKey 질의를 보강.
 *  - 도메인 필터 외 url 질의(apex/www)도 더해 호스트·apex 스코프 누락을 방지.
 * 동일 이름은 1개만(비파티션 우선 — 서버 디코드/전송에 더 안정적).
 * @returns {Promise<Map<string, {name:string, value:string, domain?:string, partitionKey?:object}>>}
 */
export async function collectMusinsaCookies() {
  const queries = [
    { domain: 'musinsa.com' },                  // 선행 점 없는 광역 매치(apex + 모든 서브도메인)
    { url: 'https://www.musinsa.com/' },
    { url: 'https://musinsa.com/' },
    { domain: 'musinsa.com', partitionKey: { topLevelSite: 'https://www.musinsa.com' } },
    { domain: 'musinsa.com', partitionKey: { topLevelSite: 'https://musinsa.com' } },
  ];
  const lists = await Promise.all(queries.map(getAllCookiesSafe));
  const byName = new Map();
  for (const list of lists) {
    for (const c of list) {
      if (!c || !c.name) continue;
      const prev = byName.get(c.name);
      if (!prev || (prev.partitionKey && !c.partitionKey)) byName.set(c.name, c);
    }
  }
  return byName;
}

export async function syncAllCookies({ includeSsg = true } = {}) {
  const result = {
    musinsaLoggedIn: false,
    musinsaSourceAccountId: null,
    musinsaWarning: null,
  };

  try {
    const byName = await collectMusinsaCookies();
    const cls = classifyMusinsaLogin(byName.keys());

    const names = [...byName.keys()];
    console.log(`[Lonit] 무신사 쿠키 ${names.length}개, status=${cls.status}, mss_mac=${cls.hasMssMac}, names=[${names.join(',')}]`);

    if (cls.status === 'logged-in') {
      const cookieStr = [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
      try {
        const response = await apiCall('/source-accounts/musinsa-cookie', {
          method: 'POST',
          body: JSON.stringify({ cookie: cookieStr }),
        });
        const sourceAccountId = response?.data?.id ?? null;
        result.musinsaLoggedIn = true;
        result.musinsaSourceAccountId = sourceAccountId;
        await chrome.storage.local.set({
          musinsaSourceAccountId: sourceAccountId,
          musinsaLoginWarning: '',
        });
        console.log(`[Lonit] 무신사 쿠키 동기화 완료: ${cookieStr.length}자, sourceAccountId=${sourceAccountId}`);
      } catch (e) {
        // 쿠키는 유효(mss_mac 존재)하나 서버 동기화 POST 만 실패(네트워크/5xx 등) — 로그아웃이 아니다.
        // musinsaLoginWarning(=heartbeat 로그인 신호)을 세팅하면 "무신사 로그인 미감지" 오탐이
        // 뜨므로 로그인 상태 스토리지는 건드리지 않는다(직전 값 유지). sourceAccountId 도 유지.
        result.musinsaWarning = e.message || '무신사 쿠키 서버 동기화에 실패했습니다.';
        console.error('[Lonit] 무신사 쿠키 서버 동기화 실패(로그인은 유효):', e.message);
      }
    } else if (cls.status === 'session-no-grade') {
      // ★ 로그인은 유효(app 토큰 존재). "로그인 안 됨" 오탐 금지 — 등급정보 갱신 안내만 남긴다.
      // 서버는 mss_mac 없으면 400("로그인 안 됨") 이므로 POST 는 스킵한다.
      // heartbeat 의 musinsaLoggedIn 신호는 로그인됨으로 유지('')해 대시보드 오탐도 차단.
      result.musinsaLoggedIn = true;
      result.musinsaWarning = cls.warning; // MUSINSA_GRADE_STALE_WARNING
      await chrome.storage.local.set({ musinsaLoginWarning: '' });
      console.warn('[Lonit] 무신사 로그인 유효하나 mss_mac(등급정보) 부재 — 등급 혜택가 일시 제외');
    } else {
      // logged-out / no-cookies — 진짜 로그아웃.
      result.musinsaWarning = cls.warning;
      await chrome.storage.local.remove(['musinsaSourceAccountId']);
      await chrome.storage.local.set({ musinsaLoginWarning: result.musinsaWarning });
      console.log(`[Lonit] 무신사 로그인 안 됨 (${cls.status}) — 쿠키 전송 스킵`);
    }

    if (includeSsg) {
      const ssgCookies = await getAllCookiesSafe({ domain: '.ssg.com' });
      if (ssgCookies.length > 0) {
        const cookieStr = ssgCookies.map((c) => `${c.name}=${c.value}`).join('; ');
        try {
          await apiCall('/source-accounts/ssg-cookie', {
            method: 'POST',
            body: JSON.stringify({ cookie: cookieStr }),
          });
          console.log(`[Lonit] SSG 쿠키 동기화 완료: ${cookieStr.length}자`);
        } catch (e) {
          console.error('[Lonit] SSG 쿠키 동기화 실패:', e.message);
        }
      }
    }
  } catch (e) {
    result.musinsaWarning = result.musinsaWarning || e.message || '쿠키 동기화에 실패했습니다.';
    console.error('[Lonit] 쿠키 동기화 전체 실패:', e.message);
  }

  return result;
}
