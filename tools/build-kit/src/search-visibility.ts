import type { Plugin } from "vite"

// A robots.txt Disallow would keep crawlers from reading this tag, so the page itself asks.
const noindex = '<meta name="robots" content="noindex" />'

/** The page, asking search engines not to index it. */
export const withNoindex = (html: string): string => {
  if (!html.includes("</head>")) throw new Error("index.html has no head to mark noindex")
  return html.replace("</head>", `  ${noindex}\n  </head>`)
}

/** Keeps the builds `hidden` says out of search results, as a public demo should be. */
export const searchVisibility = (options: {
  readonly hidden: (mode: string) => boolean
}): Plugin => {
  let mode = ""
  return {
    name: "build-kit-search-visibility",
    configResolved: (config) => void (mode = config.mode),
    transformIndexHtml: (html) => (options.hidden(mode) ? withNoindex(html) : html),
  }
}
