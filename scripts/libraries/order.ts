// The order between libraries, from each library design's `depends_on`: what the package
// graph enforces, checked by graph.test.ts. The import fence (.oxlintrc.json) holds only paths.

/** Each library, and the libraries its design lets it import. */
export const order: Readonly<Record<string, readonly string[]>> = {
  emulator: [],
  log: [],
  sandbox: [],
  terminal: ["emulator"],
  "tui-input": ["emulator"],
  viewers: [],
  wire: [],
}
