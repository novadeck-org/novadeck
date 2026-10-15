// The visitor build is a public demo that should not turn up in search results. A robots.txt
// Disallow would keep crawlers from reading this tag, so the page itself asks.
const noindex = '<meta name="robots" content="noindex" />'

export const withSearchVisibility = (html: string, mode: string): string => {
  if (mode !== "try") return html
  if (!html.includes("</head>")) throw new Error("index.html has no head to mark noindex")
  return html.replace("</head>", `  ${noindex}\n  </head>`)
}
