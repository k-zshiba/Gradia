$ErrorActionPreference = 'Stop'
$processFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools\preview-process.json'
if (-not (Test-Path -LiteralPath $processFile)) { Write-Host 'No managed preview process.'; exit 0 }
$record = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
$previewProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($previewProcess -and $previewProcess.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt -and $previewProcess.ProcessName -eq 'node') {
    Stop-Process -Id $previewProcess.Id
    Write-Host 'Gradia preview stopped.'
} else { Write-Host 'The recorded preview process is no longer running.' }
