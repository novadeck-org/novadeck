// The foundation tokens every theme defines for each scheme it offers. The "Foundation
// tokens" table in docs/theming.md lists the same names; `contract.test.ts` checks
// both against each other and every theme file against this list.

const tones = ["success", "warning", "danger", "note"] as const
const syntax = ["keyword", "string", "number", "property", "definition", "type", "comment"] as const
const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const

export const requiredTokens: readonly string[] = [
  // Grounds
  "--color-canvas",
  "--color-shell",
  "--color-paper",
  "--color-soft",
  // Text
  "--color-ink",
  "--color-muted",
  // Lines
  "--color-line",
  "--color-line-strong",
  // Emphasis
  "--color-strong",
  "--color-strong-hover",
  "--color-on-strong",
  // Overlays
  "--color-scrim",
  "--color-selection",
  "--color-shadow",
  // Tones
  ...tones.flatMap((tone) => [`--color-${tone}`, `--color-${tone}-fg`]),
  // Syntax
  ...syntax.map((kind) => `--color-syntax-${kind}`),
  // Terminal
  "--terminal-bg",
  "--terminal-fg",
  "--terminal-cursor",
  "--terminal-selection",
  ...ansi.map((colour) => `--terminal-ansi-${colour}`),
  ...ansi.map((colour) => `--terminal-ansi-${colour}-bright`),
  // Depth
  "--shadow-control",
  "--shadow-panel",
  "--shadow-floating",
  "--shadow-modal",
]
