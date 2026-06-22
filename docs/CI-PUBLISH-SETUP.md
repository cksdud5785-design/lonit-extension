# CI 자동 게시 설정 가이드 (Chrome Web Store API V2)

태그(`v*`)를 푸시하면 GitHub Actions(`.github/workflows/publish.yml`)가 자동으로
빌드 → 업로드 → 게시(검수 제출)합니다. **한 번만** 아래 자격증명을 발급해 GitHub 시크릿에 넣으면 됩니다.

> ⚠️ 자격증명(client_id/secret/refresh_token)은 보안상 **본인이 직접 발급**해야 합니다(제가 대신 발급 불가).
> 구 V1 API 는 2026-10-15 종료 → 이 설정은 **V2**(`chromewebstore.googleapis.com`) 기준입니다.

---

## 1단계 — Google Cloud: Chrome Web Store API 사용 설정
1. https://console.cloud.google.com → 프로젝트 생성(또는 선택)
2. 상단 검색창에 **"Chrome Web Store API"** → **사용 설정(Enable)**

## 2단계 — OAuth 동의 화면
1. **API 및 서비스 → OAuth 동의 화면** → User type **External** → 만들기
2. 앱 이름 / 사용자 지원 이메일 / 개발자 연락처 입력 → 저장
3. ★ **게시 상태를 "프로덕션(In production)"으로** 두세요. ("테스트" 상태로 두면 refresh_token 이 **7일 뒤 만료**됩니다.)
   (테스트로 둘 거면 "테스트 사용자"에 본인 Google 계정을 추가)

## 3단계 — OAuth 클라이언트 생성
1. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 애플리케이션 유형: **웹 애플리케이션**
3. **승인된 리디렉션 URI** 에 추가: `https://developers.google.com/oauthplayground`
4. 생성된 **클라이언트 ID** 와 **클라이언트 보안 비밀(secret)** 복사 → 보관

## 4단계 — refresh_token 발급 (OAuth Playground)
1. https://developers.google.com/oauthplayground 접속
2. 우상단 **톱니바퀴(⚙)** → **"Use your own OAuth credentials"** 체크 → 3단계의 client_id/secret 입력
3. 왼쪽 **"Input your own scopes"** 칸에 입력: `https://www.googleapis.com/auth/chromewebstore`
4. **Authorize APIs** → (확장을 게시한) 개발자 Google 계정으로 로그인/동의
5. **Exchange authorization code for tokens** → 나온 **refresh_token** 복사 → 보관

## 5단계 — EXTENSION_ID / PUBLISHER_ID 확인
- **EXTENSION_ID**: Web Store 개발자 대시보드의 항목 URL 끝 32자(또는 항목 상세) — 예: `abcdef......`
- **PUBLISHER_ID**: 개발자 대시보드 **계정(Account)** 섹션의 퍼블리셔 ID (V2 는 이 값도 필요)

## 6단계 — GitHub repo 시크릿 등록 (5개)
저장소: `cksdud5785-design/lonit-extension` → **Settings → Secrets and variables → Actions → New repository secret**

| 시크릿 이름 | 값 |
|---|---|
| `CWS_EXTENSION_ID` | 5단계 EXTENSION_ID |
| `CWS_PUBLISHER_ID` | 5단계 PUBLISHER_ID |
| `CWS_CLIENT_ID` | 3단계 client_id |
| `CWS_CLIENT_SECRET` | 3단계 client_secret |
| `CWS_REFRESH_TOKEN` | 4단계 refresh_token |

또는 `gh` CLI로(값은 프롬프트로 안전 입력):
```bash
cd C:\Users\com\Downloads\extension
gh secret set CWS_EXTENSION_ID
gh secret set CWS_PUBLISHER_ID
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
```

---

## 사용법 — 새 버전 게시
```bash
# 코드 수정 후
npm run release:patch        # 버전업(예: 1.7.19→1.7.20) + manifest 동기화 + git 커밋·태그
git push --follow-tags       # ← 태그 푸시가 CI를 트리거 → 자동 빌드/업로드/게시
```
- 진행상황: GitHub repo → **Actions** 탭에서 확인
- 수동 실행: Actions → "Publish extension" → **Run workflow**

## 동작/주의
- **게시 ≠ 즉시 반영**: 업로드+게시는 CWS **검수**를 거쳐 통과 후 라이브가 됩니다(액션 성공 ≠ 즉시 배포).
- **버전 필수 증가**: manifest version 을 안 올리면 업로드가 거부됩니다(release 스크립트가 자동 처리).
- 검수 진행 중 재게시는 실패합니다(겹치면 이전 검수 완료 후 재시도).
- 안전 옵션(워크플로 주석 참고): 업로드만(수동 게시) / `--deploy-percentage 20`(단계적) / `--trusted-testers`.
- refresh_token 이 만료되면(2단계 테스트 상태/6개월 미사용) 4단계 재발급 후 시크릿 갱신.
