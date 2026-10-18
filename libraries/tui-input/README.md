# @novadeck/tui-input

Typing into a running full-screen program and checking that the text landed: reading a TUI's input
box, checking a paste landed, classifying keys, queueing the work that types, giving the program a
prompt and interrupting its turn.

## Subpaths

- `./box` (browser-safe, pure functions of a `ScreenText` or its rows): reading a TUI's input box off a screen,
  the text comparison that tolerates how a screen draws it, and the paste check.
  - `InputBox`, what a box holds, its mode (a prompt, or a shell command) and the rows it spans.
  - `BoxProfile`, how one program draws its box: how to read it, whether a view covers it, whether
    a paste shows as a placeholder, how much room it has, which keys clear it. Knowledge of a
    particular program comes in as a profile; the library names none.
  - `ruledBox` (a box between two horizontal rules) and `markedBox` (a box with no frame), the
    readers a profile builds on, with `Markers`, `agreeing` and `footerRows`.
  - `sameText`, `endsText`, `isEmpty` and `compact`, which compare a box's text with the text sent,
    ignoring whitespace a TUI wrapped and emoji a screen drew differently; and `wrappedRows`, how
    many rows a text takes in a box.
  - `checkPaste`, whether a test paste landed where Enter would submit it alone: the line shows
    exactly once, and only the rows near it changed, tolerating a box that grew a row, a block of
    text that vanished whole, one line of history that went, and rows that tick by themselves
    (`ticking`). `findLine` says where a line is on the rows, joined across the rows it wraps over;
    `changedRows` says which rows differ between two reads.
- `.` (Node only: `keysOf` reads the emulator's Node-only `matchReport`, and `freshNonce` draws on
  `node:crypto`):
  the rest of the mechanics.
  - `keysOf(data, queueKey, reporting)`, the keys in one write, each a `Key` of one `KeyKind`:
    `enter` (a bare one), `queue` (the profile's queue key), `neutral` (Left, Home, End), `escape`,
    `accept` (Right, Tab, which may take a suggestion into an empty box) or `content`. The
    terminal's own replies are left out (a query's answer, a focus report, a mouse report that
    only moves or scrolls), but a click the program asked for counts as `content`; and a bracketed
    paste is one key, so its carriage returns never submit.
  - `gate`, whether to type now: allowed by the caller, the screen calm for `calmMs`, bracketed
    paste on, the program in the foreground, its input box on screen.
  - `freshNonce` and `bracketedPaste`, the nonce a pasted line carries and the paste itself.
  - `InputQueue`, one writer per terminal at a time, in order, over a host that holds the user's
    input (`InputQueueHost`, `HoldBudget`, `InputHold`); an entry that fails wedges nothing, and
    the input it held is let go however it ends.
  - `createTypist(target, { profile, boxCheck?, timing?, trace? })`, ringing an idle program over a
    `TypingTarget` (`type`, `screen`, `resizedAt`, `holdsForeground`): `look` reads the screen and
    measures its calm, `ready` is the gate on that look (`Readiness`), `deliver` pastes a line with a
    fresh nonce into the box and presses Enter only once it shows alone, twice running, with the hold
    still in force (`Delivered`), `submit` presses Enter alone for a line left behind, and `forget`
    drops what it saw. It decides nothing of when to ring: that stays with the caller. `profile` is a
    `BoxProfile`, or the caller's own `(screen) => boolean | undefined` for whether the box shows
    empty. `Timing` holds its durations; `pasteMsOn` and `sizeCapMs` are the defaults to build on.
  - `Prompts`, giving a program a prompt as a user would, in the terminal's turn in an
    `InputQueue`: the text as one bracketed paste with the user's keys held, and Enter only once
    the box shows exactly that text (or its placeholder) on two reads running. It pastes only into
    an empty box, never over a draft or into the box's shell mode, and presses no Enter after a
    check that failed. A text starting with `!` goes the way a user types a shell command: the `!`
    as a key, then, once the box switches, the command. The caller says what text may be given
    with `refuse` (why it can't be, or undefined), asked before the queue; `PromptRefusal`
    carries the reason (`PromptRefusalReason`) of every prompt not given, and whatever the host's
    `admit` throws passes as it is. `PromptHost` is what it needs of the terminal, and
    `collapsible` says whether a TUI may show a paste as a placeholder.
  - `Interrupts`, stopping a turn as a user's Escape does and leaving the box as it was: it waits
    for the box to settle, writes a second Escape for a turn started from queued messages, clears
    what is not the restored prompt and gives the words back as `{ returned }`, or
    `undefined` where there were none. A box left holding text it could not clear throws
    `BoxNotCleared`. `InterruptHost` is what it needs of the terminal.

`ScreenText` comes from `@novadeck/emulator/headless`, as a type only, and the width of a
character from `@novadeck/emulator/width`.
