// The handles the demo gives its terminals: the runner's words in its list's order
// (backend/runner/src/terminals/handles.ts, the first words of its list), as its tests
// give them, though a real session draws them in its own shuffle. So the demo's terminals
// keep fixed words: the first terminal's is `moth`, the second's `fox`. A session this
// long is past what the demo shows; later ones take a number.
const words = [
  "moth",
  "fox",
  "owl",
  "crow",
  "kite",
  "raven",
  "dusk",
  "volt",
  "haze",
  "lynx",
  "sable",
  "glint",
  "quill",
  "umbra",
  "plume",
  "blaze",
  "noir",
  "wisp",
  "jinx",
  "thorn",
  "aster",
  "ebony",
  "ibis",
  "xenon",
  "zenith",
  "cinder",
  "comet",
  "frost",
  "hawk",
  "mist",
  "onyx",
  "rift",
  "shrike",
  "vapor",
] as const

// The handle of a demo session's terminal by its number there, counted from 1.
export const demoHandle = (number: number): string => words[number - 1] ?? `${words[0]}${number}`
