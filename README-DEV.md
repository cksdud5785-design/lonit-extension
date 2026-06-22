# Lonit 확장 — 빌드 / 배포 가이드

이 폴더가 확장의 **정본 소스**입니다(git 추적). Chrome MV3, 순수 JS라 번들링 불필요.

## 개발 (브라우저에서 로드)
1. `chrome://extensions` → 우상단 **개발자 모드 ON**
2. **"압축해제된 항목 로드"** → 이 폴더(`manifest.json` 이 있는 곳) 선택
3. 코드 수정 후 `chrome://extensions` 에서 해당 확장 **새로고침**

> 라이브 서비스워커는 `src/background-v1226.js`(→ `src/updater-v1226.js`)입니다.
> `background.js`/`updater.js`(비-v1226)는 레거시/미로드 — 삭제하지 마세요.

## 버전 올리기 + 업로드 zip 만들기 (한 번에)
`package.json` 의 version 이 단일 소스이고, 올리면 `manifest.json` 에 자동 반영됩니다.

```bash
npm run release:patch   # 1.7.19 -> 1.7.20 (+ git commit + tag v1.7.20 + zip 빌드)
npm run release:minor   # 1.7.19 -> 1.8.0
```
- 결과 zip: `dist/lonit-extension-<version>.zip` (manifest 루트, forward-slash, 군더더기 제외)
- `npm version` 은 git 작업트리가 깨끗해야 동작합니다(먼저 변경분 커밋).

### 버전만/빌드만 따로
```bash
npm run build           # 현재 manifest 버전으로 dist zip 만 재생성 (버전 변경 X)
```

## 업로드
Chrome Web Store **개발자 대시보드** → 항목 → **"새 항목/패키지 업로드"** → `dist/lonit-extension-<version>.zip` 제출.
> ⚠️ CWS 는 **manifest version 을 올려야** 업로드를 받습니다. (release 스크립트가 자동 처리)

## 빌드 도구
- `tools/package.ps1` — `.NET ZipArchive` 로 클린 zip 생성. **`Compress-Archive` 는 백슬래시 경로 버그로 사용 금지.**
- `tools/sync-version.mjs` — package.json → manifest.json 버전 동기화(`npm version` 훅).
- zip 포함 대상(allowlist): `manifest.json, popup.html, popup.js, rules.json, icons/, src/` (src 내 `.bak/__tests__/*.test.mjs` 제외).

## CI 자동 게시 (구현됨)
태그(`v*`) 푸시 시 GitHub Actions(`.github/workflows/publish.yml`)가 **자동 빌드→업로드→게시**합니다
(Chrome Web Store API **V2**, `fregante/chrome-webstore-upload-cli@4`. 구 V1 은 2026-10-15 종료).

```bash
npm run release:patch && git push --follow-tags   # 태그 푸시가 CI 트리거 → 자동 게시
```
- **한 번만** 자격증명 발급 + GitHub 시크릿 5개 등록 필요 → **`docs/CI-PUBLISH-SETUP.md`** 참고.
- 시크릿 미설정 시 워크플로는 명확한 에러로 중단(잘못 게시되지 않음).
- 게시는 CWS **검수**를 거친 뒤 라이브(액션 성공 ≠ 즉시 반영). 안전 옵션(업로드만/단계적/신뢰테스터)은 워크플로 주석 참고.
