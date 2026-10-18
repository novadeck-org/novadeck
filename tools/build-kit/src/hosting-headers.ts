import type { Plugin } from "vite"

/** The headers a host serves the files a path pattern matches with. */
export type HeaderRule = {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * A `_headers` file, as Cloudflare Pages and Netlify read it: each path pattern, then its
 * headers indented beneath. A host applies every rule a path matches and joins a header that
 * several set, so the rules should set each header once for any path.
 */
export const headersFile = (rules: readonly HeaderRule[]): string =>
  [
    ...rules.flatMap((rule) => [
      rule.path,
      ...Object.entries(rule.headers).map(([name, value]) => `  ${name}: ${value}`),
    ]),
    "",
  ].join("\n")

/** Gives a build the response headers its host serves it with, where `rules` has any. */
export const hostingHeaders = (options: {
  readonly rules: (mode: string) => readonly HeaderRule[] | undefined
}): Plugin => {
  let mode = ""
  return {
    name: "build-kit-hosting-headers",
    apply: "build",
    configResolved: (config) => void (mode = config.mode),
    generateBundle() {
      const rules = options.rules(mode)
      if (rules) this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(rules) })
    },
  }
}
