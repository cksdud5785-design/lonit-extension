# Chrome 확장프로그램 가이드

## 역할
무신사/타 쇼핑몰 상품 페이지에서 상품 정보를 Lonit API로 전송.

## 구조
- `manifest.json` — 확장프로그램 설정 (Manifest V3)
- `src/content.ts` — 컨텐츠 스크립트 (DOM에서 상품 정보 추출)
- `src/background.ts` — 서비스 워커 (API 통신)
- `src/popup.html` — 팝업 UI
- `icons/` — 확장프로그램 아이콘

## 인증
- `X-Auth-Key` 헤더로 테넌트 식별
- API 서버: `http://localhost:4000` (개발) → `https://api.Lonit.kr` (프로덕션)
