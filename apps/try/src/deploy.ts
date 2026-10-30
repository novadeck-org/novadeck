import { connectSources } from "@novadeck/build-kit/connect-sources"
import type { Build } from "@novadeck/build-kit/content-security-policy"
import type { HeaderRule } from "@novadeck/build-kit/hosting-headers"

// How the visitor build is deployed, as vite.config.ts hands it to the build kit: what it may
// connect to, that it stays out of search results, and what its host serves it with.

/** What index.html's connect-src holds until a build fills it. */
export const connectSourcesPlaceholder = "__NOVADECK_CONNECT_SOURCES__"

// Built, the visitor build, the website's demo, reaches nothing but the page's own origin.
// Served for development, or built in a mode other than `try`, it reaches what it is
// configured for.
export const connect = (build: Pick<Build, "mode" | "command" | "env">): readonly string[] =>
  build.mode === "try" && build.command === "build"
    ? ["'self'"]
    : connectSources({
        api: { url: build.env.VITE_API_URL, name: "VITE_API_URL" },
        runner: { url: build.env.VITE_NOVADECK_RUNNER_URL, name: "VITE_NOVADECK_RUNNER_URL" },
        development: build.command === "serve",
      })

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
