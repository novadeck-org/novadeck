# @novadeck/terminal-views

The terminal views every backend draws its terminals with: what the runner's backend
(`frontend/runner-adapter`) and the demo's (`frontend/demo`) hand the terminal library's views
(`@novadeck/terminal/view`), so both draw a terminal the same way.

## Subpaths

- **`./mount`:** `createTerminalMount`, the port's `MountTerminal` over the views: each mount
  holds its terminal's screen while it is on screen and places it in the UI's element; and
  `screenMarkup`, the input attribute and the class of the element a screen draws in, which
  `src/terminal-xterm.css` styles.
- **`./emulator`:** `openEmulator`, how a screen opens its emulator: the views' font and theme,
  the page's WebGL pool, links that open web pages on ⌘- or Ctrl-click, the Ligatures setting
  from `<html>`, and a screen reader's tree only while focus is in the terminal.
- **`./renderers`:** the page's WebGL pool (`pageRenderers`), its cap for a desktop app that
  raised Chromium's limit (`configurePageRenderers`), its counts reported to the app
  (`reportRenderers`), and which views draw with WebGL (`wantsWebgl`: all but Canvas).
- **`./theme`:** `terminalTheme`, the page's theme tokens as the emulator's colours and font
  where a terminal draws; `noTheme` for a backend handed none.
- **`./paste-notice`:** `pasteNotice`, what a failed paste tells the person.

## Tests

`*.test.ts` run in jsdom. `*.spec.ts` run a terminal in headless Chromium: the WebGL renderer
(`renderers.spec.ts`), the cell both renderers fit (`cell-fit.spec.ts`), the mouse at any zoom
(`zoom.spec.ts`), and ligatures on WebGL (`ligatures.spec.ts`, its own project, with font
hinting off).
