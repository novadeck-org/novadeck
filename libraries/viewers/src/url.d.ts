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
