param([switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    if (Test-Path '.tools/cargo/bin/cargo.exe') {
        $env:CARGO_HOME = Join-Path $PWD '.tools/cargo'
        $env:RUSTUP_HOME = Join-Path $PWD '.tools/rustup'
        $env:PATH = (Join-Path $PWD '.tools/cargo/bin') + ';' + $env:PATH
    } else { throw 'Install the Rust MSVC toolchain. See README.md.' }
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand -and (Test-Path '.tools/runtime.json')) {
    $runtime = Get-Content '.tools/runtime.json' -Raw | ConvertFrom-Json
    if (Test-Path -LiteralPath $runtime.nodePath) {
        $env:PATH = (Split-Path $runtime.nodePath -Parent) + ';' + $env:PATH
    }
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    if (Test-Path '.tools/package/bin/npm-cli.js') {
        $shimDirectory = Join-Path $PWD '.tools/shims'
        New-Item -ItemType Directory -Force $shimDirectory | Out-Null
        $nodeExecutable = (Get-Command node).Source
        $npmEntry = Join-Path $PWD '.tools/package/bin/npm-cli.js'
        $shim = "@echo off`r`nchcp 65001 >nul`r`n" + ('@"' + $nodeExecutable + '" "' + $npmEntry + '" %*') + "`r`n"
        [IO.File]::WriteAllText((Join-Path $shimDirectory 'npm.cmd'), $shim, (New-Object Text.UTF8Encoding($false)))
        $env:PATH = $shimDirectory + ';' + $env:PATH
    } else { throw 'Install Node.js LTS, including npm.' }
}
if ($Build) { & npm run package } else { & npm run desktop }
exit $LASTEXITCODE
