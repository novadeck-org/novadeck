# @novadeck/terminal

Hosting terminals and attaching to them: a pty, a headless screen kept in step with it, a
resumable stream of it, its browser view, and shell integration.

## Subpaths

- `.`: the attach contract both sides speak, as Zod schemas and the types they give.
  - `TerminalEvent`: what a viewer receives, a `snapshot` of the screen, `output`, `resized` or
    `exited`, each numbered by `sequence`. `terminalEvents` has the schema of each kind, so a
    consumer can wrap them in its own envelope (a terminal's id, say) instead of restating them.
    `columns`, `rows` and `exit` are the size and the way a shell ended that they carry.
  - `TerminalError`: why an attach or a call on it fails, by its `code`. A consumer maps the
    codes to its own errors; `SLOW_CONSUMER` and `INVALID_CURSOR` name the same failures a
    transport's resumable streams do.
  - `AttachStream`: one attached stream as a client holds it, its events acknowledged as it
    reads the next.

- `./view` (browser): the terminal's view, which the app's terminals mount on.
  - `createTerminalViews(options)` keeps one screen per terminal: an emulator, its attachment
    followed into it, and the pastes it takes. `acquire(key, { label, phase, webgl })` returns a
    `Hold` to `place` the screen in an element, `update`, `focus`, `restart` and `release`; its
    `state` is a store of what the person is told (`live`, `resuming`, `waits`, `lock`, `notice`).
    A released screen parks after `park.afterMs`, closes after `retain.afterMs` away, and the
    parked longest closes past `park.keep`.
  - The owner gives the emulator, theme, stream, wording and policies as options; the view
    knows no app, wire or protocol. `store` is optional (a plain store otherwise); an owner
    that observes its stores passes its own. Files pasted in are saved on the terminal's host
    through the owner's `paste.upload`, and go in as their paths there.
  - `parkMs` and `parkedCap` are the park defaults, `ViewPhase` and `PasteFailure` what an
    owner words, and `pause(ms)` a promise that resolves after `ms`.
  - It builds on `@novadeck/emulator/browser`, and its tests run under jsdom.

The others are Node only: each names only the `node` condition, so a browser bundle can't
resolve it.

- `./host`: hosting terminals.
  - `createTerminalHost(options)` keeps a host's terminals: `reserve` holds a place for one
    starting, within `maxTerminals`, letting the oldest exited terminal no one reads go for
    room. After each exit, exited terminals past `maxRetained` go, oldest first, and
    `evicted` listeners are told. `terminate` ends a terminal's program within the kill's
    budget (shorter as the host shuts down), and `remove` keeps a closed one until its viewers
    have read the rest (its caller refuses its id meanwhile; `draining` tells). `shutdown` ends
    every program, then lets every terminal go. `attach` attaches a viewer once the draws
    before it are drawn, keeping the terminal meanwhile, and yields `attached`, then the
    events. `restart` starts a new run of an exited terminal in place, one restart at a time,
    after its caller's waiting.
  - Each `Terminal` the host opens runs its program in a pty with a headless screen, and keeps
    the events that follow the screen and who reads them.
  - What the program prints is drawn on the screen in order, behind everything queued before
    it: reads that arrive while a draw waits join it, the program pauses while a
    lot waits, and an earlier run's output is dropped. Each draw is told to `drawn` listeners,
    then sent in events of at most 4,096 characters. Its title, the directory its prompt
    reports (OSC 7 or 9;9) and a full reset are told too, and its exit, in order: `exit`
    listeners, the `exited` event, every attachment finished, then `exited` listeners.
    `readScreen(read?)` reads the screen, and `replay(text)` draws on it, behind the draws
    queued before.
  - Its input: `input` writes the controller's keys, `type` the holder's own. `hold(budget)`
    holds the person's keys for one piece of work, as a doorbell's paste or an answer's keys,
    and the window's resizes until it settles. Throughout, the terminal's own reports
    (cursor and device answers, the focus and mouse reports its program asked for) go through
    at once. Keys that count as the person's are told to `keys` listeners just before they are
    written. A deferred hold counts them only once delivered, and drops
    the mouse's wheel and motion.
  - It sequences each event and keeps a replay ring bounded in bytes. A viewer attaches from a
    cursor the ring still holds, or else from a snapshot of the screen, with as much
    scrollback as fits its own cap. One attachment controls the terminal and the rest observe.
  - Each attachment has a queue bounded in bytes, and an ack window that holds delivery until
    the viewer catches up. A viewer that falls behind fails with `SLOW_CONSUMER`, to reconnect
    and resume.
  - Every budget counts an event at `eventBytes`: what the transport sends, envelope and all.
  - `restart` starts a new run in place, in one step: the earlier run's screen goes, the ring
    starts over and skips a sequence number, so an earlier cursor gets a snapshot, and the
    caller's own state is swapped in the same step. A program that can't start throws
    `SPAWN_FAILED`, leaving the earlier run as it was.

- `./pty`: a terminal's processes.
  - A `Terminal` runs its program in a `Pty`, through node-pty (an optional peer: install it to
    use `./host`), started as `PtyOptions` say; on Windows its arguments can be one command
    line, as cmd needs. Its `pid` is undefined until it is known,
    never 0 (on Windows, 0 names the host until the program's output connects); `drawn` says
    output has arrived; it reports its exit once, its code null where the program's isn't
    known yet. `end(options)` runs the whole kill sequence: a hangup to the foreground group
    (not on Windows, which has none),
    the kill, a forced end past `graceMs`, and on Windows the process tree read first and what
    of it is left ended after `treeGraceMs`; a stopped orphaned group is resumed. Where the
    program's own exit may never come, as for a Windows kill queued until the first draw, the
    pty takes it as ended. `platform` decides all of this, so a test can play a ConPTY with a
    stand-in `native` on any system. `userScopes()` keeps each Linux program in a systemd scope
    of its own, so an out-of-memory kill takes only it.
  - `sampleForeground(child, last)` names the program in a terminal's foreground, cheaply
    enough to sample, from `/proc` on Linux and `ps` on macOS (Windows can't tell).
    `terminalForeground`, `processGroup`, `foregroundProcess`, `foregroundRuns`, `openFiles`,
    `processSetting` and `shellInForeground` read the facts it's built on; a pid not known
    yet tells nothing.
  - `Trees` reads and ends a process's tree on Windows, which has no process groups and lets a
    parent's pid be reused, through a relay: a program the caller ships that answers `tree`
    with each root's members by pid and start, and ends members by both with `end`. Calls in
    one tick share one run of it, and `ProcessTrees` is what a pty asks of it; without one,
    taskkill ends the tree. `anyRunning` says whether members still run.
- `./shell`: what a shell reports and needs.
  - `shellScripts` writes the files bash, zsh, fish and PowerShell read after the user's own
    setup, where `shellScriptPaths` lays them out. Each reports the directory at every prompt,
    puts `<PREFIX>_BIN` back first on PATH after the user's startup files, and runs a startup
    command once from the file `<PREFIX>_RESUME` names, which removing first cancels. The app
    names them: its prefix, given to `shellScriptPaths` (`acme` gives `ACME_BIN` and
    `__acme_prompt`), and the comment each file opens with.
  - `shellLaunch` gives a shell the arguments and environment that load them (cmd reports
    through its `PROMPT` and takes the command with `/k`), with a folder put first and a
    startup command; `startsCommands` says which shells run one. `shQuote` and `cmdQuote` quote
    a value as one word of sh and cmd.
  - `refreshPath` merges the folders the Windows registry's PATH has now into an environment,
    read through the relay where it's given one, else through PowerShell, cached and backed off
    on failure; `readRegistry` reads it once, `forgetPath` drops the cache, and `pathKey` is
    PATH's own spelling in an environment.
  - `withLocale` gives a shell on macOS a UTF-8 `LANG` where it has none.
  - `afterKeys` follows roughly what a shell's line holds after keys are sent, from
    `emptyLine`, to tell whether a line was entered.

## Packaging

An app that ships `./pty` ships node-pty, a native module: it keeps it out of its bundle and
out of any archive it packs (Electron's `asarUnpack`), uses the N-API prebuilds rather than
rebuilding, and on Windows ships the prebuilds' `conpty` folder (`conpty.dll` and
`OpenConsole.exe`), which every Windows pty runs with.

## Tests

`pnpm --filter @novadeck/terminal test`. The native tests and the macOS foreground tests run
real ptys, so node-pty is a dev dependency, with its patch in `patches/` (three Windows fixes:
a failed input write no longer ends the host, `kill()` is safe twice, and an exit waits for its
code). The tests that read trees and the registry through a real relay run in the app that
ships one.

`./testing` (Node only) is for tests of what hosts a pty: `ptyChild`, a program to run in one
with Node, which answers `command`s with output, sizes, bursts, exits and children of its own,
and `ptyTrace`, what it last received and wrote; and `nativeStandIn`, a stand-in for node-pty's
terminal that plays a ConPTY's quirks, to give a pty (`PtyOptions`) as its `native` with
`platform` `"win32"` on any system.
