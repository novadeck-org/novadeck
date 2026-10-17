# @novadeck/terminal

Hosting terminals and attaching to them: a pty, a headless screen kept in step with it, a
resumable stream of it, its browser view, and shell integration. So far it has the attach
contract, an attached viewer's queue, the process facts and the shell integration; the rest arrives
a part at a time.

## Subpaths

- `.`: the attach contract both sides speak, as Zod schemas and the types they give.
  - `terminalEvent`: what a viewer receives, a `snapshot` of the screen, `output`, `resized` or
    `exited`, each numbered by `sequence`. `terminalEvents` has each kind apart, so a consumer
    can wrap them in its own envelope (a terminal's id, say) instead of restating them.
    `columns`, `rows` and `exit` are the size and the way a shell ended that they carry.
  - `terminalErrorCodes` and `TerminalError`: why an attach or a call on it fails. A consumer
    maps the codes to its own errors; `SLOW_CONSUMER` and `INVALID_CURSOR` name the same
    failures a transport's resumable streams do.
  - `AttachStream`: one attached stream as a client holds it, its events acknowledged as it
    reads the next.

The others are Node only: each names only the `node` condition, so a browser bundle can't
resolve it.

- `./host`: `Subscription`, one attached viewer's events: a queue bounded in bytes, an ack
  window that holds delivery until the viewer catches up, and one initial snapshot under its
  own cap. A viewer that falls behind fails with `SLOW_CONSUMER`, to reconnect and resume. It
  counts each event at its JSON's size in its consumer's envelope, so the budgets are what the
  transport sends.

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
  - `shellScripts` writes the files bash, zsh, fish and PowerShell read after the user's own
    setup, where `shellScriptPaths` lays them out. Each reports the directory at every prompt,
    puts `<PREFIX>_BIN` back first on PATH after the user's startup files, and runs a startup
    command once from the file `<PREFIX>_RESUME` names, which removing first cancels. The app
    names them: its prefix, given to `shellScriptPaths` (`acme` gives `ACME_BIN` and
    `__acme_prompt`), and the comment each file opens with.
  - `shellLaunch` gives a shell the arguments and environment that load them (cmd reports
    through its `PROMPT` and takes the command with `/k`), with a folder put first and a
    startup command; `startsCommands` says which shells run one. `shQuote`, `psQuote`,
    `fishQuote` and `cmdQuote` quote a value as one word of each language.
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
