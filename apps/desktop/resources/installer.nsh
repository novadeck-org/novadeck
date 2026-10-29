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
# A self-update stays silent: builder's message boxes that carry a silent default (`/SD`:
# a failed copy, a failed uninstall retry) answer themselves, where a non-silent run would put
# Retry/Cancel in front of someone who just quit, and Cancel after the old app was removed
# leaves none. It shows no progress window either: builder's banner plugin, with no window of
# the setup's to sit in, looks through every dialog on the desktop.
#
# A self-update starts nothing, as the app must not restart itself, except in one case: it
# had to close a copy the person reopened after the quit began. That copy is told from the
# quitting app by its start time: the quitting app was running before this setup was started
# (the app starts it as it quits), a reopened copy started after. `customInstall` then
# starts the app, which opens as the new version, since the person asked for it. The host's
# `--force-run` (a reopen while the app was still shutting down) makes builder's template
# start the app; `customInstall` then starts nothing, so the app starts once.
#
# The installer also leaves a marker, `RunningCheck`, in builder's install registry key
# (deleted with it on uninstall), by which the host tells installed copies that have this
# check from older ones, whose uninstaller the new setup runs first.
!ifndef BUILD_UNINSTALLER
  # 1 once a self-update has closed a copy that was started after this setup was.
  Var novadeckReopened
!endif

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" RunningCheck 1

  # Builder's template starts nothing after a silent run unless it is given `--force-run`,
  # and then this starts nothing, so the app starts once. A self-update that closed a
  # reopened copy starts it. A portable copy's install (silent, not `--updated`) never does.
  ${IfNot} ${isForceRun}
  ${AndIf} ${Silent}
  ${AndIf} ${isUpdated}
  ${AndIf} $novadeckReopened == 1
    # Otherwise the app window would be in the background.
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${EndIf}
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
  Push $7

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
  !ifndef BUILD_UNINSTALLER
    StrCpy $novadeckReopened 0
  !endif
  # $7 = 1 while what runs from the install folder includes a process started after this
  # setup was: the person reopened Novadeck once the quit had begun. The app that was
  # quitting started this setup, so it is older.
  StrCpy $7 0
  ${Do}
    # $1 = 1 while something runs from the install folder; $5 = 1 when PowerShell answered.
    StrCpy $1 0
    StrCpy $5 0
    ${If} ${FileExists} "$PowerShellPath"
      # Exit 10: found, 13: found and one started after this setup, 11: none, 12: the query
      # itself failed. A timeout answers "timeout".
      nsExec::Exec /TIMEOUT=15000 `"$PowerShellPath" -NoProfile -NonInteractive -C "try { $$d = $$env:NOVADECK_INSTALL_DIR.TrimEnd('\') + '\'; $$all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop); $$me = $$all | Where-Object { $$_.ProcessId -eq [int]$$env:NOVADECK_SETUP_PID } | Select-Object -First 1; $$p = @($$all | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne [int]$$env:NOVADECK_SETUP_PID -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$p.Count -eq 0) { exit 11 }; if ($$me -and $$me.CreationDate -and @($$p | Where-Object { $$_.CreationDate -gt $$me.CreationDate }).Count -gt 0) { exit 13 }; exit 10 } catch { exit 12 }"`
      Pop $0
      ${If} $0 == 10
      ${OrIf} $0 == 13
        StrCpy $1 1
        StrCpy $5 1
        ${If} $0 == 13
          StrCpy $7 1
        ${Else}
          StrCpy $7 0
        ${EndIf}
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
      !ifndef BUILD_UNINSTALLER
        # What is closed here that was started after this setup is a reopened copy; a self-update
        # (the only run that is `isUpdated` here) then starts the new version once installed.
        ${If} $7 == 1
        ${AndIf} ${isUpdated}
          StrCpy $novadeckReopened 1
        ${EndIf}
      !endif
      nsExec::Exec /TIMEOUT=15000 `"$PowerShellPath" -NoProfile -NonInteractive -C "$$d = $$env:NOVADECK_INSTALL_DIR.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne [int]$$env:NOVADECK_SETUP_PID -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $3 }"`
      Pop $0
    ${EndIf}
    Sleep 1000

  ${Loop}

  !insertmacro _novadeckClearEnvironment
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
