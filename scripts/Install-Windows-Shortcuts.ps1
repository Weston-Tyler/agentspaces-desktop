$ErrorActionPreference = 'Stop'
$shortcutProductRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$shortcutTarget = (Get-Command powershell.exe).Source
$shortcutArguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Open-Desktop.ps1') + '"'
$shortcutIcon = Join-Path $shortcutProductRoot 'assets/agentspaces.ico'
if (-not (Test-Path -LiteralPath $shortcutIcon)) { throw 'AgentSpaces desktop icon is missing.' }
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($shortcutEntry in @(
    @{ Folder=[Environment]::GetFolderPath('Desktop'); Name='AgentSpaces Desktop.lnk'; Script='Open-Desktop.ps1' },
    @{ Folder=[Environment]::GetFolderPath('Programs'); Name='AgentSpaces Desktop.lnk'; Script='Open-Desktop.ps1' },
    @{ Folder=[Environment]::GetFolderPath('Startup'); Name='AgentSpaces Background.lnk'; Script='Start-Background.ps1' }
)) {
    $shortcutArguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot $shortcutEntry.Script) + '"'
    $shortcutPath = Join-Path $shortcutEntry.Folder $shortcutEntry.Name
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $shortcutTarget -or $shortcut.Arguments -ne $shortcutArguments)) {
        throw "Existing unrelated shortcut preserved: $shortcutPath"
    }
    $shortcut.TargetPath = $shortcutTarget
    $shortcut.Arguments = $shortcutArguments
    $shortcut.WorkingDirectory = $shortcutProductRoot
    $shortcut.IconLocation = $shortcutIcon + ',0'
    $shortcut.Description = 'AgentSpaces Desktop — your connected Codex and Claude threads'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Output $shortcutPath
}
# Reuse the companion-owned service; the native setup has no model calls.
& $shortcutTarget -NoProfile -File (Join-Path $PSScriptRoot 'Start-Background.ps1')
if ($LASTEXITCODE -ne 0) { throw 'The owned background service could not start.' }
Push-Location $shortcutProductRoot
try {
    for ($setupAttempt = 0; $setupAttempt -lt 30; $setupAttempt++) {
        node app/cli.mjs status 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
    node scripts/install-connected-tools.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Native setup needs an active Connect all scope; existing native sessions were preserved.' }
} finally { Pop-Location }
