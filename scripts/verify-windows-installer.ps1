# Destructive install/uninstall acceptance is restricted to a disposable CI host.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Run installer acceptance only on a disposable Windows GitHub Actions runner.'
}
$setup = @(Get-ChildItem (Join-Path $PSScriptRoot '..\dist\AgentSpaces-Desktop-Setup-*-x64.exe'))
if ($setup.Count -ne 1) { throw 'Expected exactly one installer.' }
$root = Join-Path $env:RUNNER_TEMP ('agentspaces-install-check-' + [guid]::NewGuid())
$destination = Join-Path $root 'application'
$workspace = Join-Path $env:APPDATA 'AgentSpaces Desktop\workspace'
if (Test-Path $workspace) { throw 'Refusing to touch an existing workspace.' }
$fixture = $null
function Run-Setup([string]$path, [string[]]$arguments) {
  $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
  if (!$process.WaitForExit(90000)) { throw 'Installer did not finish in its acceptance window.' }
  return $process.ExitCode
}
function Start-Fixture([string]$binary) {
  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = $binary
  $process.StartInfo.Arguments = '-e "console.log(''fixture-ready'');setInterval(()=>{},1000)"'
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  if (!$process.Start()) { throw 'Fixture could not start.' }
  $ready = $process.StandardOutput.ReadLineAsync()
  if (!$ready.Wait(10000) -or $ready.Result -ne 'fixture-ready') { throw 'Fixture did not become ready.' }
  return $process
}
function Stop-Fixture {
  if ($script:fixture -and !$script:fixture.HasExited) {
    # Only this synthetic Node timer is terminated; never an application/model.
    $script:fixture.Kill()
    $script:fixture.WaitForExit()
  }
  $script:fixture = $null
}
try {
  New-Item -ItemType Directory -Force (Join-Path $destination 'resources\runtime') | Out-Null
  $fixtureBinary = Join-Path $destination 'resources\runtime\node.exe'
  Copy-Item (Get-Command node.exe).Source $fixtureBinary
  $fixture = Start-Fixture $fixtureBinary
  $blockedInstall = Run-Setup $setup[0].FullName @('/S', ('/D=' + $destination))
  if ($blockedInstall -ne 2 -or $fixture.HasExited -or (Test-Path (Join-Path $destination 'AgentSpaces Desktop.exe'))) {
    throw 'Busy setup did not refuse without stopping the fixture.'
  }
  Stop-Fixture
  Remove-Item $destination -Recurse -Force
  $installed = Run-Setup $setup[0].FullName @('/S', ('/D=' + $destination))
  if ($installed -ne 0) { throw 'Fresh silent installation failed.' }
  $app = Join-Path $destination 'resources\app'
  $binary = Join-Path $destination 'resources\runtime\node.exe'
  $uninstaller = Join-Path $destination 'Uninstall AgentSpaces Desktop.exe'
  if (!(Test-Path (Join-Path $destination 'AgentSpaces Desktop.exe')) -or !(Test-Path $uninstaller)) {
    throw 'Installed application or uninstaller is absent.'
  }
  $shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AgentSpaces Desktop.lnk'
  if (!(Test-Path $shortcut)) { throw 'Start menu registration is absent.' }
  $registered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object {
    $_.DisplayName -eq 'AgentSpaces Desktop' -and ([string]$_.InstallLocation).TrimEnd('\') -eq $destination.TrimEnd('\')
  })
  if ($registered.Count -ne 1) { throw 'Installed Apps registration is absent.' }
  Push-Location $app
  try {
    & $binary --input-type=module -e "import{wire}from'@agentspaces/client';import{readFileSync}from'node:fs';if(wire.WIRE_VERSION!==3||JSON.parse(readFileSync('package.json')).version!=='0.1.0-alpha.4')throw Error('Installed version mismatch');"
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime import check failed.' }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force $workspace | Out-Null
  $sentinel = Join-Path $workspace 'acceptance-sentinel.txt'
  [IO.File]::WriteAllText($sentinel, 'Synthetic retained workspace; no credentials or native account.')
  $fixture = Start-Fixture $binary
  $blockedUninstall = Run-Setup $uninstaller @('/S', ('_?=' + $destination))
  if ($blockedUninstall -ne 2 -or $fixture.HasExited -or !(Test-Path (Join-Path $destination 'AgentSpaces Desktop.exe'))) {
    throw 'Busy uninstall did not refuse without stopping the fixture.'
  }
  Stop-Fixture
  # Exercise NSIS's normal temporary-launch path. Its parent can exit before
  # the temporary uninstaller; observe removal rather than assuming completion.
  $removed = Run-Setup $uninstaller @('/S')
  if ($removed -ne 0) { throw 'Uninstaller launcher failed.' }
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $pending = (Test-Path (Join-Path $destination 'AgentSpaces Desktop.exe')) -or (Test-Path $uninstaller) -or (Test-Path $registered[0].PSPath) -or (Test-Path $shortcut)
    if (!$pending) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Normal uninstallation did not finish removing application and registration.' }
    Start-Sleep -Milliseconds 500
  } while ($true)
  if (!(Test-Path $sentinel) -or [IO.File]::ReadAllText($sentinel) -ne 'Synthetic retained workspace; no credentials or native account.') { throw 'Uninstallation changed retained workspace state.' }
  [pscustomobject]@{freshInstall=$true;startMenu=$true;installedApps=$true;runtimeImports=$true;busyInstallRefused=$true;busyUninstallRefused=$true;uninstall=$true;workspaceRetained=$true;nativeModelCalls=0} | ConvertTo-Json -Compress
} finally {
  Stop-Fixture
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
  if (Test-Path $workspace) { Remove-Item $workspace -Recurse -Force }
}
