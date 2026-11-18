// The sizes a terminal takes, both ends included: the attach contract checks them, and the
// view holds a fitted size to them. Apart from the contract, so the view needs no Zod.
export const sizeBounds = {
  cols: { min: 2, max: 500 },
  rows: { min: 1, max: 200 },
} as const

// The most columns a view fits a terminal to, however wide its frame: past this the screen
// stops growing, its lines left where they start. Near the chat's reading width (92ch,
// frontend/chat's `--chat-measure`), yet wide enough that agents' TUIs still draw tables
// and diffs as such (Claude Code turns a table into a list at 92). A line past it is hard
// to follow, and a program that redraws its whole width, as agents' TUIs do on every key,
// has that much more to draw.
export const measureCols = 120
