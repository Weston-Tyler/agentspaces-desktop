$ErrorActionPreference = 'Stop'
$shortcutProductRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$shortcutTarget = (Get-Command powershell.exe).Source
$shortcutArguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Open-Desktop.ps1') + '"'
$shortcutIcon = Join-Path $shortcutProductRoot 'assets/agentspaces.ico'
if (-not (Test-Path -LiteralPath $shortcutIcon)) { throw 'AgentSpaces desktop icon is missing.' }
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($shortcutFolder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcutPath = Join-Path $shortcutFolder 'AgentSpaces Desktop.lnk'
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
