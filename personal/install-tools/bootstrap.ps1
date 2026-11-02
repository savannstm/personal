$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Running a .ts file directly needs Node's built-in type stripping, which is on by default from 22.18.
$minimum = [version]'22.18.0'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if ($node -and ([version]((& $node --version).TrimStart('v')) -lt $minimum)) {
    $node = $null
}

if (-not $node) {
    $version = (Invoke-RestMethod 'https://nodejs.org/dist/index.json')[0].version
    $msi = Join-Path $env:TEMP "node-$version-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$version/node-$version-x64.msi" -OutFile $msi
    $install = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart', 'INSTALLDIR=C:\PATH\node' -Wait -PassThru
    Remove-Item $msi
    # 3010: installed, reboot pending.
    if ($install.ExitCode -notin 0, 3010) { throw "Node install failed (msiexec exit code $($install.ExitCode)); run this from an elevated shell." }
    $node = 'C:\PATH\node\node.exe'
    if (-not (Test-Path $node)) { throw 'Node is not installed.' }
}

& $node (Join-Path $PSScriptRoot 'index.ts') @args
exit $LASTEXITCODE
