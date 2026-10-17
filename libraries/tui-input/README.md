# @novadeck/tui-input

Typing into a running full-screen program and checking that the text landed: reading a TUI's input
box, checking a paste landed, classifying keys, and queueing the work that types.

## Subpaths

- `./box` (browser-safe, pure functions of a `ScreenText`): reading a TUI's input box off a screen,
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
- `.` (Node only, as `keysOf` reads the emulator's `matchReport`, which the browser can't import):
  the rest of the mechanics.
  - `keysOf(data, queueKey, reporting)`, the keys in one write, each a `Key` of one `KeyKind`:
    `enter` (a bare one), `queue` (the profile's queue key), `neutral` (Left, Home, End), `escape`,
    `accept` (Right, Tab, which may take a suggestion into an empty box) or `content`. The
    terminal's own replies (a query's answer, a mouse or focus report the program asked for) are
    left out, and a bracketed paste is one key, so its carriage returns never submit.
  - `gate`, whether to type now: allowed by the caller, the screen calm for `calmMs`, bracketed
    paste on, the program in the foreground, its input box on screen.
  - `freshNonce` and `bracketedPaste`, the nonce a pasted line carries and the paste itself.
  - `InputQueue`, one writer per terminal at a time, in order, over a host that holds the user's
    input (`InputQueueHost`, `HoldBudget`, `InputHold`); an entry that fails wedges nothing, and
    the input it held is let go however it ends.

`ScreenText` comes from `@novadeck/emulator/headless`, as a type only, and the width of a
character from `@novadeck/emulator/width`.
