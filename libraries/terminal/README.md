# @novadeck/terminal

Hosting terminals and attaching to them: a pty, a headless screen kept in step with it, a
resumable stream of it, its browser view, and shell integration. Its subpaths so far are the
process facts and the shell helpers; the rest arrives a part at a time.

## Subpaths

Both are Node only: each names only the `node` condition, so a browser bundle can't resolve it.

- `./pty`: a terminal's processes.
  - `sampleForeground(child, last)` names the program in a terminal's foreground, cheaply
    enough to sample, from `/proc` on Linux and `ps` on macOS (Windows can't tell).
    `terminalForeground`, `processGroup`, `foregroundProcess`, `foregroundRuns`, `openFiles`,
    `processSetting` and `shellInForeground` read the facts it's built on.
  - `Trees` reads and ends a process's tree on Windows, which has no process groups and lets a
    parent's pid be reused, through a relay: a program the caller ships that answers `tree`
    with each root's members by pid and start, and ends members by both with `end`. Calls in
    one tick share one run of it. `taskkillTree` is the fallback without one, `anyRunning`
    whether members still run.
- `./shell`: what a shell reports and needs.
  - `osc7Directory` and `osc9Directory` read the directory a shell reports (OSC 7 from bash,
    zsh and fish, only for this machine; OSC 9;9 from PowerShell and cmd).
  - `refreshPath` merges the folders the Windows registry's PATH has now into an environment,
    read through the relay where it's given one, else through PowerShell, cached and backed off
    on failure; `pathKey` is PATH's own spelling in an environment.
  - `withLocale` gives a shell on macOS a UTF-8 `LANG` where it has none.
  - `afterKeys` follows roughly what a shell's line holds after keys are sent, to tell whether
    a line was entered.

## Tests

`pnpm --filter @novadeck/terminal test`. The macOS foreground tests run real ptys, so node-pty
is a dev dependency. The tests that read trees and the registry through a real relay run in the
app that ships one.
