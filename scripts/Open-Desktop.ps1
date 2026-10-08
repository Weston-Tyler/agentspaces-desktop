$ErrorActionPreference = 'Stop'
$desktopProductRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopRuntimePath = Join-Path $desktopProductRoot '.local/runtime.json'
if (-not (Test-Path -LiteralPath $desktopRuntimePath)) {
    & (Join-Path $PSScriptRoot 'Start-Background.ps1') | Out-Null
    for ($desktopWait = 0; $desktopWait -lt 30 -and -not (Test-Path -LiteralPath $desktopRuntimePath); $desktopWait++) {
        Start-Sleep -Milliseconds 300
    }
}
if (-not (Test-Path -LiteralPath $desktopRuntimePath)) { throw 'Companion did not start. Check the local runtime logs.' }
$env:AGENTSPACES_DESKTOP_RUNTIME = $desktopRuntimePath
$desktopElectronPath = Join-Path $desktopProductRoot 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path -LiteralPath $desktopElectronPath)) { throw 'Install the locked dependencies with npm ci first.' }
Start-Process -FilePath $desktopElectronPath -ArgumentList ('"' + $desktopProductRoot + '"') -WorkingDirectory $desktopProductRoot -WindowStyle Hidden
