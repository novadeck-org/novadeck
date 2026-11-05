import { configuredSources } from "@novadeck/build-kit/connect-sources"
import type { Build } from "@novadeck/build-kit/content-security-policy"
import type { HeaderRule } from "@novadeck/build-kit/hosting-headers"
import type { Plugin } from "vite"

// How the visitor build is deployed, as vite.config.ts hands it to the build kit: what it may
// connect to, that it stays out of search results, and what its host serves it with.

// Built, the visitor build, the website's demo, reaches nothing but the page's own origin.
// Served for development, or built in a mode other than `try`, it reaches what it is
// configured for.
export const connect = (build: Pick<Build, "mode" | "command" | "env">): readonly string[] =>
  build.mode === "try" && build.command === "build" ? ["'self'"] : configuredSources(build)

/** The visitor build is a public demo that should not turn up in search results. */
export const hidden = (mode: string): boolean => mode === "try"

// The response headers Cloudflare Pages serves the visitor build with, as its `_headers`
// file. Only the website, novadeck.dev, may frame the demo; a preview of the website shows
// its drawing instead. The page asks search engines to stay away in its markup too, but a
// header covers every file. Files under assets/ carry their content's hash in their name,
// so a browser may keep them for good. The posters keep their names from one deploy to the
// next, so they are kept only briefly. Cloudflare applies every rule a path matches and joins
// a header that several set, so no two rules here set the same one.
const website = "https://novadeck.dev"

export const headerRules = (mode: string): readonly HeaderRule[] | undefined =>
  mode === "try"
    ? [
        {
          path: "/*",
          headers: {
            "Content-Security-Policy": `frame-ancestors 'self' ${website}`,
            "X-Robots-Tag": "noindex",
          },
        },
        { path: "/assets/*", headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
        { path: "/poster-*", headers: { "Cache-Control": "public, max-age=300" } },
      ]
    : undefined

// Without a top-level 404.html, Cloudflare Pages takes the build for a single-page app and
// answers every missing path with index.html: a hashed asset gone since a deploy then comes
// back as a page under /assets/*, kept for good, and would stay broken even if a rollback
// brought that file back. With one, a missing file is a 404, which Pages serves with no-store
// and without the rules above (as the website's own missing files show), so the page says
// what those rules would: it runs nothing and stays out of search results. A person who
// mistypes an address is sent on to the demo, as the single-page answer took them there
// before, though to `/` itself: a page without script can't carry the address's query on.
export const notFoundPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'" />
    <meta http-equiv="refresh" content="0; url=/" />
    <meta name="robots" content="noindex" />
    <title>Novadeck</title>
  </head>
  <body>
    <p>Nothing is here. <a href="/">Open the Novadeck demo</a>.</p>
  </body>
</html>
`

/** Gives the visitor build its 404.html, which no other build needs. */
export const notFound = (): Plugin => {
  let mode = ""
  return {
    name: "try-not-found",
    apply: "build",
    configResolved: (config) => void (mode = config.mode),
    generateBundle() {
      if (mode === "try")
        this.emitFile({ type: "asset", fileName: "404.html", source: notFoundPage })
    },
  }
}
