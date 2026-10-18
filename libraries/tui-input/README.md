# @novadeck/tui-input

Typing into a running full-screen program and checking that the text landed: reading a TUI's input
box, and comparing what it shows with what was sent.

## Subpaths

- `./box` (browser-safe, pure functions of a `ScreenText`): reading a TUI's input box off a screen,
  and the text comparison that tolerates how a screen draws it.
  - `InputBox`, what a box holds, its mode (a prompt, or a shell command) and the rows it spans.
  - `BoxProfile`, how one program draws its box: how to read it, whether a view covers it, whether
    a paste shows as a placeholder, how much room it has, which keys clear it. Knowledge of a
    particular program comes in as a profile; the library names none.
  - `ruledBox` (a box between two horizontal rules) and `markedBox` (a box with no frame), the
    readers a profile builds on, with `Markers`, `agreeing` and `footerRows`.
  - `sameText`, `endsText`, `isEmpty` and `compact`, which compare a box's text with the text sent,
    ignoring whitespace a TUI wrapped and emoji a screen drew differently; and `wrappedRows`, how
    many rows a text takes in a box.

`ScreenText` comes from `@novadeck/emulator/headless`, as a type only, and the width of a
character from `@novadeck/emulator/width`.
