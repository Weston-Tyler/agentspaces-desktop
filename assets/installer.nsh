# Override electron-builder's default stop/force-kill path for both installation
# and uninstallation. An update waits for an owner-controlled quiet window.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    StrCpy $R9 "$INSTDIR\resources\app\assets\windows-install-guard.ps1"
  !else
    InitPluginsDir
    File /oname=$PLUGINSDIR\windows-install-guard.ps1 "${BUILD_RESOURCES_DIR}\windows-install-guard.ps1"
    StrCpy $R9 "$PLUGINSDIR\windows-install-guard.ps1"
  !endif
  System::Call 'kernel32::SetEnvironmentVariable(t "AGENTSPACES_INSTALL_ROOT", t "$INSTDIR") i.r0'
  System::Call 'kernel32::GetCurrentProcessId() i.r1'
  System::Call 'kernel32::SetEnvironmentVariable(t "AGENTSPACES_INSTALLER_PID", t "$1") i.r0'
  nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$R9"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ${IfNot} ${Silent}
      ${If} $0 == 10
        MessageBox MB_OK|MB_ICONINFORMATION "AgentSpaces or its companion is still running. Let active work finish, quit AgentSpaces from its tray menu and stop the companion, then run setup again. No processes have been stopped."
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not verify that AgentSpaces is stopped. Close it and its companion, then try again. No files or processes have been changed."
      ${EndIf}
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
