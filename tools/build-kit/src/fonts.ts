/**
 * Vite's `build.assetsInlineLimit` that always ships fonts as files: a Content Security Policy
 * with `font-src 'self'` loads them only from the app itself, so a small subset Vite would
 * inline as a data: URL would be blocked. Other assets keep Vite's own limit.
 */
export const fontsAsFiles = (file: string): boolean | undefined =>
  /\.woff2?$/.test(file) ? false : undefined
