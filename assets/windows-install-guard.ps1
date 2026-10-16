# Installer/uninstaller admission only. Never stop an application or native turn.
$ErrorActionPreference = 'Stop'
try {
  # Native launchers may use an 8.3 parent path and a long child path in the
  # same argument. Parse arguments with Windows' own rules, then expand each
  # existing path before comparing it with the installation directory.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentSpacesInstallPaths {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetLongPathName(string path, StringBuilder buffer, uint size);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  public static string Expand(string path) {
    var buffer = new StringBuilder(32768);
    uint length = GetLongPathName(path, buffer, (uint)buffer.Capacity);
    return length > 0 && length < buffer.Capacity ? buffer.ToString() : path;
  }
  public static string[] Arguments(string command) {
    int count;
    IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var arguments = new string[count];
      for (int i = 0; i < count; i++)
        arguments[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return arguments;
    } finally { LocalFree(memory); }
  }
}
'@
  $root = $env:AGENTSPACES_INSTALL_ROOT
  if ([string]::IsNullOrWhiteSpace($root) -or ![IO.Path]::IsPathRooted($root)) { exit 2 }
  $prefix = [AgentSpacesInstallPaths]::Expand([IO.Path]::GetFullPath($root)).TrimEnd('\') + '\'
  $installerPid = 0
  if (![int]::TryParse($env:AGENTSPACES_INSTALLER_PID, [ref]$installerPid) -or $installerPid -lt 1) { exit 2 }
  # Detect the supported external-Node launch as well as bundled executables.
  # Command lines are inspected locally and are never logged or persisted.
  function Uses-InstalledPath([string]$command) {
    if (!$command) { return $false }
    if ($command.Replace('/', '\').IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    foreach ($argument in [AgentSpacesInstallPaths]::Arguments($command)) {
      # Most arguments are code/options, not paths. Path.IsPathRooted on .NET
      # Framework throws on valid non-path arguments containing quotes or pipes.
      if ($argument -match '^(?:[A-Za-z]:[\\/]|\\\\)' -and [AgentSpacesInstallPaths]::Expand($argument.Replace('/', '\')).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $command -match '(?i)(?:^|[\s"''])(?:\.[\/])?app[\/]cli\.mjs["'']?\s+serve(?:\s|$)'
  }
  $running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $installerPid -and $_.ProcessId -ne $PID -and (
      ($_.ExecutablePath -and [AgentSpacesInstallPaths]::Expand([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
      (Uses-InstalledPath $_.CommandLine)
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
