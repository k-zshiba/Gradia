param([string]$CacheDirectory = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS'))
$ErrorActionPreference = 'Stop'
$cache = [IO.Path]::GetFullPath($CacheDirectory)
$required = @('makensis.exe','Bin\makensis.exe','Stubs\lzma-x86-unicode','Stubs\lzma_solid-x86-unicode','Include\MUI2.nsh','Include\FileFunc.nsh','Include\x64.nsh','Include\nsDialogs.nsh','Include\WinMessages.nsh','Include\Win\COM.nsh','Include\Win\Propkey.nsh','Include\Win\RestartManager.nsh')
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $cache $_)) }
$nsisExe = Join-Path $cache 'NSIS.exe'
$validExe = (Test-Path -LiteralPath $nsisExe) -and ((Get-FileHash -LiteralPath $nsisExe -Algorithm SHA1).Hash -eq '6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2')
if ($missing -or -not $validExe) {
    $zip = Join-Path $PWD '.tools/bundler-downloads/nsis.zip'
    node scripts/download-bundler.mjs nsis $zip
    if ($LASTEXITCODE -ne 0) { throw 'Could not download NSIS' }
    $staging = Join-Path $PWD '.tools/bundler-downloads/extracted'
    Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    # The official ZIP has an nsis-3.13 top-level folder, not a flat layout.
    Get-ChildItem -LiteralPath (Join-Path $staging 'nsis-3.13') | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $cache -Recurse -Force
    }
}
$plugin = Join-Path $cache 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
$validPlugin = (Test-Path -LiteralPath $plugin) -and ((Get-FileHash -LiteralPath $plugin -Algorithm SHA1).Hash -eq '75197FEE3C6A814FE035788D1C34EAD39349B860')
if (-not $validPlugin) {
    node scripts/download-bundler.mjs utils $plugin
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the NSIS Tauri plugin' }
}
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $cache $file))) { throw ('NSIS cache is missing ' + $file) }
}
