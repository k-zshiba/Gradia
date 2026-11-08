$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path 'node_modules/vite/bin/vite.js')) {
    throw '先に npm install を実行してください。'
}
Write-Host '画面プレビュー: http://127.0.0.1:1420 （終了: Ctrl+C）'
& node 'scripts/pdf-assets.mjs'
& node 'node_modules/vite/bin/vite.js' --host 127.0.0.1
