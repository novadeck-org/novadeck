# Included by electron-builder into the installer and the uninstaller (the default
# `installer.nsh` of the build resources). Its `customCheckAppRunning` replaces
# builder's own running-app check (`CHECK_APP_RUNNING`), which ends up stopping every
# process named novadeck.exe by name where PowerShell is not usable. That would close a
# portable copy running from another folder, and a portable copy installs itself by
# running this setup silently while it keeps running. See docs/auto-update.md.
#
# One rule, in terms of the install folder alone:
#   - Novadeck runs from it when any process other than this setup has a path inside
#     "$INSTDIR\" (PowerShell, which also catches helpers such as ConPTY's OpenConsole.exe
#     that outlive novadeck.exe). Without PowerShell, when novadeck.exe there cannot be
#     opened for writing. A copy running from any other folder never counts.
#   - The installer's silent run that is not a self-update (`--updated`) closes nothing: it
#     ends with exit code 3, leaving the install as it was. A portable copy's install is
#     that run.
#   - A self-update, and a silent uninstaller (an update's run of the old one, or `/S`
#     from a script), gives the quitting app a moment, then closes what still runs from
#     $INSTDIR. An interactive uninstaller (Windows Settings, or the app's own Uninstall,
#     which starts it and quits right after) waits two rounds the same way, then asks
#     before closing; an interactive installer asks first. Both then close.
#   - Only processes whose path is inside "$INSTDIR\" are closed, by PowerShell, never by
#     name, and never this setup itself. Without PowerShell nothing is closed: the person
#     is asked to close Novadeck, or a silent run ends.
#
# The installer also leaves a marker, `RunningCheck`, in builder's install registry key
# (deleted with it on uninstall), by which the host tells installed copies that have this
# check from older ones, whose uninstaller the new setup runs first.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" RunningCheck 1
!macroend

# Takes the variables the PowerShell commands read out of this process's environment once
# the check passes, so the app the installer may start afterwards and its shells do not
# inherit them (a run that quits takes them with it).
!macro _novadeckClearEnvironment
  System::Call 'kernel32::SetEnvironmentVariable(t "NOVADECK_SETUP_PID", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "NOVADECK_INSTALL_DIR", p 0)'
!macroend

# Everything is inline: the uninstaller uses this macro too, where a plain Function
# could not be called.

!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6

  # What the PowerShell commands below read, instead of quoting a path into them.
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "NOVADECK_SETUP_PID", t "$0")'
  System::Call 'kernel32::SetEnvironmentVariable(t "NOVADECK_INSTALL_DIR", t "$INSTDIR")'

  # $4 = how the app is dealt with when it runs:
  #   0  an interactive installer: ask in round 1, then close.
  #   1  a self-update (`--updated`) or a silent uninstaller: the app is quitting, wait
  #      one round, then close.
  #   2  an interactive uninstaller, which the app starts and quits for: wait two rounds,
  #      ask in round 3, then close.
  # $6 = the round it is closed from (the round it is asked in, for 0 and 2).
  !ifdef BUILD_UNINSTALLER
    ${If} ${Silent}
      StrCpy $4 1
    ${Else}
      StrCpy $4 2
    ${EndIf}
  !else
    ${If} ${isUpdated}
      StrCpy $4 1
    ${Else}
      StrCpy $4 0
    ${EndIf}
  !endif
  ${If} $4 == 0
    StrCpy $6 1
  ${ElseIf} $4 == 1
    StrCpy $6 2
  ${Else}
    StrCpy $6 3
  ${EndIf}

  StrCpy $2 0 # rounds waited for the app to go
  ${Do}
    # $1 = 1 while something runs from the install folder; $5 = 1 when PowerShell answered.
    StrCpy $1 0
    StrCpy $5 0
    ${If} ${FileExists} "$PowerShellPath"
      # Exit 10: found, 11: none, 12: the query itself failed. A timeout answers "timeout".
      nsExec::Exec /TIMEOUT=15000 `"$PowerShellPath" -NoProfile -NonInteractive -C "try { $$d = $$env:NOVADECK_INSTALL_DIR.TrimEnd('\') + '\'; $$n = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne [int]$$env:NOVADECK_SETUP_PID -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }).Count; if ($$n -gt 0) { exit 10 } else { exit 11 } } catch { exit 12 }"`
      Pop $0
      ${If} $0 == 10
        StrCpy $1 1
        StrCpy $5 1
      ${ElseIf} $0 == 11
        StrCpy $5 1
      ${EndIf}
    ${EndIf}
    ${If} $5 == 0
    ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      # No PowerShell answer: the installed executable cannot be opened for writing while it runs.
      ClearErrors
      FileOpen $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
      ${If} ${Errors}
        StrCpy $1 1
      ${Else}
        FileClose $0
      ${EndIf}
    ${EndIf}
    ${If} $1 == 0
      ${ExitDo}
    ${EndIf}

    IntOp $2 $2 + 1

    ${If} $2 > 6
      # Still there at round 7, after the rounds of closing it. Probably running with more rights than this setup, or locked by something else.
      ${If} $4 == 1
      ${OrIf} ${Silent}
        SetErrorLevel 3
        Quit
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
      Quit
      IntOp $2 $6 + 2
    ${EndIf}

    ${If} $4 == 0
    ${AndIf} ${Silent}
      # Nobody to ask, and the running copy may be a portable one the person is using.
      SetErrorLevel 3
      Quit
    ${EndIf}

    ${If} $2 == $6
    ${AndIf} $4 != 1
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
      DetailPrint "$(appClosing)"
    ${EndIf}

    # From the closing round on, politely twice, then by force.
    ${If} $5 == 1
    ${AndIf} $2 >= $6
      IntOp $0 $2 - $6
      ${If} $0 > 1
        StrCpy $3 "Stop-Process -Id $$_.ProcessId -Force"
      ${Else}
        StrCpy $3 "(Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue).CloseMainWindow()"
      ${EndIf}
      nsExec::Exec /TIMEOUT=15000 `"$PowerShellPath" -NoProfile -NonInteractive -C "$$d = $$env:NOVADECK_INSTALL_DIR.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne [int]$$env:NOVADECK_SETUP_PID -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $3 }"`
      Pop $0
    ${EndIf}
    Sleep 1000

  ${Loop}

  !insertmacro _novadeckClearEnvironment
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
