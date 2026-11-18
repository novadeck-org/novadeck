// Files a bundler serves beside the page, imported as their address.
declare module "*?url" {
  const url: string
  export default url
}

// Files the tests import lazily, as the bundler finds them by pattern.
interface ImportMeta {
  glob<Value>(
    patterns: string | readonly string[],
    options: { readonly query: string; readonly import: string },
  ): Record<string, () => Promise<Value>>
}

// A viewer's code as its sandboxed frame runs it, bundled into one script, as the tests import it
// (@novadeck/build-kit/frame-bundles).
declare module "*?frame" {
  const code: string
  export default code
}
