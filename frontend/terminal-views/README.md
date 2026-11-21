# @novadeck/terminal-views

The terminal views every backend draws its terminals with: what the runner's backend
(`frontend/runner-adapter`) and the demo's (`frontend/demo`) hand the terminal library's views
(`@novadeck/terminal/view`), so both draw a terminal the same way.

## Subpaths

- **`./mount`:** `createTerminalMount`, the port's `MountTerminal` over the screens: each mount
  holds its terminal's screen while it is on screen and places it in the UI's element, drawn
  with WebGL in every view but Canvas; and
  `screenMarkup`, the input attribute and the class of the element a screen draws in, which
  `src/terminal-xterm.css` styles; importing `./mount` brings that stylesheet.
- **`./emulator`:** `openEmulator`, how a screen opens its emulator: the screens' font and theme,
  the WebGL pool it is given, links that open web pages on ⌘- or Ctrl-click, the Ligatures
  setting from `<html>`, and a screen reader's tree only while focus is in the terminal.
- **`./renderer-pool`:** the page's WebGL pool (`pageRendererPool`), its context limit for a
  desktop app that raised Chromium's (`configurePageRendererPool`), and its counts reported to
  the app (`reportRendererPool`).
- **`./theme`:** `terminalTheme`, the page's theme tokens as the emulator's colours and font
  where a terminal draws; `noTheme` for a backend handed none.
- **`./rings`:** `ringRows`, the screens' overlay that draws the doorbell's rows and turn-end blocks
  (`attachDoorbell` in the emulator) from a `RingFeed` (what the runner lists of a terminal's rings and
  deliveries, and the session's handles) and the page's theme: Messages' hue tokens
  (`--avatar-hue-N-fg`, `--avatar-you-fg`) with the terminal's ANSI colours behind them, notices read by
  `@novadeck/core/notices`. `contentOf` and `hueColours` are its pieces.
- **`./paste-notice`:** `pasteNotice`, what a failed paste tells the person.

## Tests

`*.test.ts` run in jsdom. `*.spec.ts` run a terminal in headless Chromium: the WebGL renderer
(`renderers.spec.ts`), the doorbell's overlay over real recordings of Claude Code, Codex and Antigravity at 80, 120 and 200 columns in both renderers (`doorbell.spec.ts`, its recordings in `src/doorbell-recordings/`), the cell both renderers fit (`cell-fit.spec.ts`), the mouse at any zoom
(`zoom.spec.ts`), and ligatures on WebGL (`ligatures.spec.ts`, its own project, with font
hinting off).
