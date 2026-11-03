import { header } from "@novadeck/harness-core/header"

// Where cmd's AutoRun prints, Antigravity's hooks (which it runs as "cmd /c <command>" through
// whatever "cmd" PATH names first; Go does not read ComSpec, and adds no "/d") stand behind
// that output, and no answer reads as JSON. While Antigravity is connected, Novadeck's
// Windows shells run it through this shim, which puts `cmdShimDir` first on PATH for
// Antigravity alone: a folder holding Novadeck's cmd.exe pass-through as "cmd.exe" (see
// backend/relay). That folder reaches everything Antigravity starts, so the pass-through adds
// "/d" only to Novadeck's own hook command ("if defined NOVADECK_HOOK ..."); any other "cmd"
// runs with the arguments it got, AutoRun included, as the person's commands always did.
//
// `where` lists matches in PATH order, this shim included, and the first other runnable one
// wins. `$PATH:` keeps the search to PATH: a plain `where` looks in the current folder first,
// where a cloned repo's `agy.cmd` would be taken for the real one. The folder goes on PATH
// only inside a Novadeck terminal that names this shim (NOVADECK_TERMINAL_ID and
// NOVADECK_SHIMS), and under `setlocal`, so the terminal's shell keeps its PATH.
export const makeCmdShim = (cmdShimDir: string): string => `@echo off
${header("rem", "shim for agy")}
rem Runs the real agy with Novadeck's cmd.exe pass-through first on PATH, for agy alone.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:agy 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo agy: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Antigravity is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" agy " >nul || goto plain
set "PATH=${cmdShimDir};%PATH%"
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for agy" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`
