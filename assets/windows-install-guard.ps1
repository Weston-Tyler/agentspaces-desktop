# Installer/uninstaller admission only. Never stop an application or native turn.
$ErrorActionPreference = 'Stop'
try {
  $root = $env:AGENTSPACES_INSTALL_ROOT
  if ([string]::IsNullOrWhiteSpace($root) -or ![IO.Path]::IsPathRooted($root)) { exit 2 }
  $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $installerPid = 0
  if (![int]::TryParse($env:AGENTSPACES_INSTALLER_PID, [ref]$installerPid) -or $installerPid -lt 1) { exit 2 }
  # Detect the supported external-Node launch as well as bundled executables.
  # Command lines are inspected locally and are never logged or persisted.
  $running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $installerPid -and (
      ($_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and (
        $_.CommandLine.Replace('/', '\').IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $_.CommandLine -match '(?i)(?:^|[\s"''])(?:\.[\/])?app[\/]cli\.mjs["'']?\s+serve(?:\s|$)'
      ))
    )
  })
  if ($running.Count -gt 0) { exit 10 }
  # A privately wrapped companion may not name installed scripts in its command
  # line. Its standard (or inherited custom) listening port still fences setup.
  $ports = @(43127)
  $customPort = 0
  if ([int]::TryParse($env:AGENTSPACES_PORT, [ref]$customPort) -and $customPort -ge 1 -and $customPort -le 65535) { $ports += $customPort }
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports })
  if ($listeners.Count -gt 0) { exit 10 }
  exit 0
} catch {
  # Unavailable process observation is not permission to overwrite a running app.
  exit 2
}
