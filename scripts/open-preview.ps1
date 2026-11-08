param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $workspacePath
$url = 'http://127.0.0.1:1420'
$toolsPath = Join-Path $workspacePath '.tools'
New-Item -ItemType Directory -Force -Path $toolsPath | Out-Null

function Get-PreviewStatus {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        if ($response.Content -notmatch 'Gradia') {
            throw 'Port 1420 is used by another application. Close it before starting this preview.'
        }
        return $true
    } catch [System.Net.WebException] {
        return $false
    }
}

if (-not (Get-PreviewStatus)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    $runtimeFile = Join-Path $toolsPath 'runtime.json'
    if (-not $nodePath -and (Test-Path -LiteralPath $runtimeFile)) {
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if (Test-Path -LiteralPath $runtime.nodePath) { $nodePath = $runtime.nodePath }
    }
    if (-not $nodePath) {
        throw 'Node.js was not found. Install Node.js LTS, then run npm install in this folder.'
    }
    $vitePath = Join-Path $workspacePath 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path -LiteralPath $vitePath)) { throw 'Dependencies are missing. Run npm install first.' }
    & $nodePath (Join-Path $PSScriptRoot 'pdf-assets.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the PDF resources.' }
    $previewProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $vitePath + '"'), '--host', '127.0.0.1', '--port', '1420', '--strictPort') -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $toolsPath 'preview.log') -RedirectStandardError (Join-Path $toolsPath 'preview-error.log')
    $started = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($previewProcess.HasExited) { throw 'Preview stopped. See .tools/preview-error.log.' }
        if (Get-PreviewStatus) { $started = $true; break }
    }
    if (-not $started) { throw 'Preview startup timed out. See .tools/preview-error.log.' }
    @{ pid = $previewProcess.Id; startedAt = $previewProcess.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $toolsPath 'preview-process.json') -Encoding utf8
}
Write-Host ('Gradia preview: ' + $url)
Write-Host 'The browser preview uses sample data. Use Gradia from the Start menu for local files and translation.'
if (-not $NoBrowser) { Start-Process $url }
