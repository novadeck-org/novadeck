// The response headers Cloudflare Pages serves the visitor build with, as its `_headers`
// file. Only the website, novadeck.dev, may frame the demo; a preview of the website shows
// its drawing instead. The page asks search engines to stay away in its markup too, but a
// header covers every file. Files under assets/ carry their content's
// hash in their name, so a browser may keep them for good. The posters keep their names
// from one deploy to the next, so they are kept only briefly. Cloudflare applies every
// rule a path matches and joins a header that several set, so no two rules here set the
// same one.
const website = "https://novadeck.dev"

export const tryHeaders = (): string =>
  [
    "/*",
    `  Content-Security-Policy: frame-ancestors 'self' ${website}`,
    "  X-Robots-Tag: noindex",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/poster-*",
    "  Cache-Control: public, max-age=300",
    "",
  ].join("\n")
