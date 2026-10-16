# Installer/uninstaller admission only. Never stop an application or native turn.
$ErrorActionPreference = 'Stop'
try {
  $root = $env:AGENTSPACES_INSTALL_ROOT
  if ([string]::IsNullOrWhiteSpace($root) -or ![IO.Path]::IsPathRooted($root)) { exit 2 }
  $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $installerPid = 0
  if (![int]::TryParse($env:AGENTSPACES_INSTALLER_PID, [ref]$installerPid) -or $installerPid -lt 1) { exit 2 }
  $running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $installerPid -and $_.ExecutablePath -and
      [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) { exit 10 }
  exit 0
} catch {
  # Unavailable process observation is not permission to overwrite a running app.
  exit 2
}
