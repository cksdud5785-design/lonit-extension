// 목적: dist 의 최신 빌드 zip 을 Chrome Web Store 에 업로드+게시한다.
//   GitHub Actions 빌링 블락 등으로 CI 가 못 돌 때의 로컬 대안. (CWS API V2, chrome-webstore-upload-cli)
//   비밀값은 파일에 저장하지 않고 '환경변수'로만 받는다.
//   필요 env: CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, EXTENSION_ID, (선택) PUBLISHER_ID
// 사용 예(PowerShell):
//   $env:CLIENT_ID='...'; $env:CLIENT_SECRET='...'; $env:REFRESH_TOKEN='...'; $env:EXTENSION_ID='...'; $env:PUBLISHER_ID='...'
//   npm run build; npm run publish:cws
import { readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const required = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'EXTENSION_ID'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[cws-publish] 누락된 환경변수: ${missing.join(', ')}`);
  console.error('  설정법은 docs/CI-PUBLISH-SETUP.md 참고. 5개 값을 env 로 export 한 뒤 다시 실행하세요.');
  process.exit(1);
}

const distDir = path.resolve('dist');
if (!existsSync(distDir)) {
  console.error('[cws-publish] dist/ 가 없습니다 — 먼저 `npm run build` 를 실행하세요.');
  process.exit(1);
}
const zips = readdirSync(distDir)
  .filter((f) => /^lonit-extension-.*\.zip$/.test(f))
  .map((f) => ({ f, t: statSync(path.join(distDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (!zips.length) {
  console.error('[cws-publish] dist 에 lonit-extension-*.zip 이 없습니다 — `npm run build` 먼저.');
  process.exit(1);
}

const zip = path.join(distDir, zips[0].f);
console.log(`[cws-publish] 업로드+게시: ${zip}`);
// 인자 없는 호출 = 업로드 + 게시(검수 제출). 업로드만 하려면 'upload' 서브커맨드를 추가.
const r = spawnSync('npx', ['--yes', 'chrome-webstore-upload-cli@4', '--source', zip], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
if (r.status !== 0) {
  console.error('[cws-publish] 게시 실패 — 위 출력 확인. (등록정보 요건 미충족 시 대시보드에서 보완)');
}
process.exit(r.status ?? 1);
