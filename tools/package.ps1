# 목적: Chrome Web Store 업로드용 클린 zip 빌드.
#   - .NET ZipArchive 사용(=forward-slash 경로, ZIP 규격 준수). PowerShell Compress-Archive 는
#     백슬래시 경로를 써서 CWS 가 거부할 수 있으므로 절대 쓰지 않는다.
#   - manifest.json 이 zip 루트에 오도록 폴더 '내용물'을 담는다(Chrome 필수 규격).
#   - 런타임에 필요한 파일만 allowlist 로 포함하고, src 내 .bak/__tests__/*.test.mjs 등은 제외.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot   # tools/ 의 상위 = 확장 루트
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$name = 'lonit-extension'

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$dest = Join-Path $distDir "$name-$version.zip"
if (Test-Path $dest) { Remove-Item $dest -Force }

# 매니페스트가 참조하는 런타임 파일만 포함(allowlist) — 새 군더더기 동봉 방지.
$include = @('manifest.json', 'popup.html', 'popup.js', 'rules.json', 'icons', 'src')
$bs = [char]92; $fs = [char]47
$exclSubstr = @('.bak', '.test.mjs', '.NOTES.md')
$exclDir = @('__tests__', '__fixtures__', 'fixtures')

$files = New-Object System.Collections.Generic.List[string]
foreach ($r in $include) {
  $p = Join-Path $root $r
  if (Test-Path $p -PathType Leaf) { $files.Add($p) }
  elseif (Test-Path $p -PathType Container) {
    Get-ChildItem $p -Recurse -File -Force | ForEach-Object { $files.Add($_.FullName) }
  }
}

$zip = [System.IO.Compression.ZipFile]::Open($dest, 'Create')
$added = 0; $skipped = 0
try {
  foreach ($f in $files) {
    $rel = ($f.Substring($root.Length + 1)).Replace($bs, $fs)
    $skip = $false
    foreach ($d in $exclDir) { if ($rel -match "(^|$fs)$d$fs") { $skip = $true; break } }
    if (-not $skip) { foreach ($s in $exclSubstr) { if ($rel.Contains($s)) { $skip = $true; break } } }
    if ($skip) { $skipped++; continue }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $added++
  }
} finally { $zip.Dispose() }

$sizeKb = [math]::Round((Get-Item $dest).Length / 1KB)
Write-Host "[package] built: $dest"
Write-Host "[package] version=$version  files=$added  skipped(junk)=$skipped  size=${sizeKb}KB"
Write-Host "[package] -> Chrome Web Store 개발자 대시보드에서 이 zip 을 업로드하세요."
