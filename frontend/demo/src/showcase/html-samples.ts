import type { FilePart } from "@novadeck/core/items"

import { fileLines, ready, studio, type SampleArtifact } from "./artifacts"

// The web pages an agent shows: a three-panel comic strip with its stylesheet and pictures
// beside it, which the pane draws as a page; the same page after its stylesheet was written
// again, a page whose files are missing, and one too long to draw, which shows its source.
// They're files in a folder, read as the runner reads them: the page's own lines, and the files
// beside it by name, in parts.

const folder = `${studio}/strip`
const text = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>

// A panel's picture: a sky, a ground and a face, in its own colours.
const panel = (sky: string, ground: string, face: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="${sky}"/>` +
  `<rect y="140" width="300" height="60" fill="${ground}"/><circle cx="150" cy="100" r="38" fill="${face}"/>` +
  '<circle cx="136" cy="94" r="5" fill="#2d2a24"/><circle cx="164" cy="94" r="5" fill="#2d2a24"/>' +
  '<path d="M130 116 Q150 134 170 116" fill="none" stroke="#2d2a24" stroke-width="4" stroke-linecap="round"/></svg>'

const stylesheet = (ground: string): string =>
  [
    `body { margin: 0; padding: 24px; background: ${ground}; color: #2d2a24; font-family: Georgia, serif; }`,
    "h1 { margin: 0 0 16px; font-size: 28px; }",
    ".strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }",
    `.panel { margin: 0; border: 3px solid #2d2a24; background: #fff; box-shadow: 4px 4px 0 #c4704f; }`,
    ".panel img { display: block; width: 100%; }",
    ".panel figcaption { padding: 8px 10px; font-size: 14px; border-top: 3px solid #2d2a24; }",
    ".sun { height: 56px; margin-top: 16px; background: url(img/sun.svg) center / contain no-repeat; }",
  ].join("\n")

const files = (ground: string): ReadonlyMap<string, Uint8Array<ArrayBuffer>> =>
  new Map([
    ["strip.css", text(stylesheet(ground))],
    ["img/one.svg", text(panel("#bfd8e8", "#7d8454", "#f1c27d"))],
    ["img/two.svg", text(panel("#e8c9bf", "#6b7148", "#e0ac69"))],
    ["img/three.svg", text(panel("#d9d2f0", "#7d8454", "#c68642"))],
    [
      "img/sun.svg",
      text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><circle cx="50" cy="30" r="22" fill="#e8b04a"/></svg>',
      ),
    ],
  ])

const page = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '  <meta charset="utf-8">',
  "  <title>Three panels</title>",
  '  <link rel="stylesheet" href="strip.css">',
  "</head>",
  "<body>",
  "  <h1>Monday, in three panels</h1>",
  '  <div class="strip">',
  '    <figure class="panel"><img src="img/one.svg" alt=""><figcaption>The agent wakes up.</figcaption></figure>',
  '    <figure class="panel"><img src="img/two.svg" alt=""><figcaption>The tests are red.</figcaption></figure>',
  '    <figure class="panel"><img src="img/three.svg" alt=""><figcaption>The tests are green.</figcaption></figure>',
  "  </div>",
  '  <div class="sun"></div>',
  "</body>",
  "</html>",
]

const item = (id: string, name: string, detail: string): SampleArtifact["item"] => ({
  id,
  kind: "file",
  name,
  detail,
  path: `${folder}/${name}`,
  url: null,
  lines: null,
  secret: false,
})

// The page's file and those beside it as they are read, `part` bytes at a time (the runner's 2 MiB
// unless given), `delay` ms each; a name that isn't among them is missing.
const readOf =
  (
    beside: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
    { part = 2 * 1024 * 1024, delay = 0 } = {},
  ) =>
  async (name: string, offset: number): Promise<FilePart> => {
    const bytes = beside.get(name)
    if (!bytes) return { state: "unavailable", reason: "missing" }
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return { state: "part", bytes: bytes.slice(offset, offset + part) }
  }

const content = (name: string, lines: readonly string[], stamp: string, truncated = false) => ({
  state: "ready" as const,
  stamp,
  content: { ...fileLines(`${folder}/${name}`, lines, { from: 1, to: lines.length }), truncated },
})

const sample = (ground: string, stamp = "1", delay = 0): SampleArtifact => ({
  item: item("studio-strip", "strip.html", "HTML page, 3 panels"),
  content: content("strip.html", page, stamp),
  file: { read: async () => text(page.join("\n")), beside: readOf(files(ground), { delay }) },
})

/** The strip again, as the agent rewrote its stylesheet: a new stamp, and the page's ground another colour. */
export const stripAgain = (stamp: string, ground: string): SampleArtifact => sample(ground, stamp)

/** The ground the strip's stylesheet gives the page, which the first draft shows. */
export const stripGround = "#f6f1e7"

export const htmlSamples = {
  shown: sample(stripGround),
  // Its files come a moment apart: the page draws once they are in.
  slow: {
    ...sample(stripGround, "1", 700),
    item: item("studio-strip-slow", "slow-strip.html", "HTML page, files read slowly"),
  },
  // The same page with nothing beside it: drawn as the browser would, unstyled and with no pictures.
  bare: {
    item: item("studio-strip-bare", "bare-strip.html", "HTML page, files missing"),
    content: content("bare-strip.html", page, "1"),
    file: { read: async () => text(page.join("\n")), beside: readOf(new Map()) },
  },
  // Past what the runner reads of a page (2 MiB), as it reports it: cut short, so the pane shows
  // its source.
  long: {
    item: item("studio-strip-long", "long-strip.html", "HTML page, 3 MB"),
    content: content("long-strip.html", page.slice(0, 12), "1", true),
    file: { read: async () => text(page.join("\n")), beside: readOf(files(stripGround)) },
  },
  // A page written by hand, in one line with no doctype, the way a quick answer comes: it
  // draws in quirks mode, with what a page does then.
  plain: {
    item: item("studio-strip-plain", "hello.html", "HTML page"),
    content: ready({
      ...fileLines(`${folder}/hello.html`, ["<h1>Hello</h1><p>No styles, no pictures.</p>"], {
        from: 1,
        to: 1,
      }),
    }),
    file: { read: async () => text("<h1>Hello</h1>"), beside: readOf(new Map()) },
  },
} satisfies Record<string, SampleArtifact>
