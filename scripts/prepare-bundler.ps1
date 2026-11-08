$ErrorActionPreference = 'Stop'
$cache = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
if (-not (Test-Path -LiteralPath (Join-Path $cache 'makensis.exe'))) {
    $zip = Join-Path $PWD '.tools/bundler-downloads/nsis.zip'
    node scripts/download-bundler.mjs nsis $zip
    if ($LASTEXITCODE -ne 0) { throw 'Could not download NSIS' }
    Expand-Archive -LiteralPath $zip -DestinationPath $cache -Force
}
$plugin = Join-Path $cache 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
if (-not (Test-Path -LiteralPath $plugin)) {
    node scripts/download-bundler.mjs utils $plugin
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the NSIS Tauri plugin' }
}
