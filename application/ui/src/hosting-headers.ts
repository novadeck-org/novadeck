// The response headers Cloudflare Pages serves the visitor build with, as its `_headers`
// file. Only the website, novadeck.dev, may frame the demo; a preview of the website shows
// its drawing instead. The page asks search engines to stay away in its markup too, but a
// header covers every file. Files under assets/ carry their content's
// hash in their name, so a browser may keep them for good.
const website = "https://novadeck.dev"

export const tryHeaders = (): string =>
  [
    "/*",
    `  Content-Security-Policy: frame-ancestors 'self' ${website}`,
    "  X-Robots-Tag: noindex",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n")
