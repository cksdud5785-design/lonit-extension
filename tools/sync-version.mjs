// 목적: package.json 의 version 을 manifest.json 에 반영 (npm version 'version' 훅에서 호출).
// package.json = 버전 단일 소스. 버전 줄만 정규식 치환해 매니페스트 포맷을 보존한다.
import { readFileSync, writeFileSync } from 'node:fs';

const pkgUrl = new URL('../package.json', import.meta.url);
const manifestUrl = new URL('../manifest.json', import.meta.url);

const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
let manifest = readFileSync(manifestUrl, 'utf8');

const before = manifest.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
if (before === pkg.version) {
  console.log(`[sync-version] manifest already at ${pkg.version}`);
} else {
  manifest = manifest.replace(/("version"\s*:\s*")[^"]+(")/, `$1${pkg.version}$2`);
  writeFileSync(manifestUrl, manifest);
  console.log(`[sync-version] manifest.json ${before} -> ${pkg.version}`);
}
