# Installs Deno if missing, then runs the dev tools installer. Usage: .\bootstrap.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$deno = (Get-Command deno -ErrorAction SilentlyContinue).Source

if (-not $deno) {
    $dir = 'C:\PATH\deno'
    $zip = Join-Path $env:TEMP 'deno.zip'
    New-Item -ItemType Directory -Force $dir | Out-Null
    Invoke-WebRequest 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile $zip
    Expand-Archive $zip $dir -Force
    Remove-Item $zip
    $deno = Join-Path $dir 'deno.exe'
}

& $deno run -A (Join-Path $PSScriptRoot 'index.ts')
exit $LASTEXITCODE
