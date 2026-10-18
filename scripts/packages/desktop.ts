import { posix } from "node:path"

import { isText, keeps, type Edit, type Kept } from "./move.ts"

// What step 5's 5.3c moves, and how each mention of a moved file is rewritten: pure, so
// move-desktop.ts runs it over the tree and its tests run it over text. See README.md.

/** The folder that moves whole, and where. */
export const host = { from: "application/host", to: "apps/desktop" } as const

const ui = "frontend/ui"
const renderer = `${host.to}/renderer`

/**
 * The files that move on their own: the desktop app's page and the browser app's, with their
 * entries, from the UI into the desktop app, and the test of the desktop page's build. A
 * page's script is its entry itself, as in apps/try; `null` deletes a script that only
 * imported it.
 */
export const singles: readonly { readonly from: string; readonly to: string | null }[] = [
  { from: `${ui}/index.html`, to: `${renderer}/index.html` },
  { from: `${ui}/src/entries/desktop.tsx`, to: `${renderer}/main.tsx` },
  { from: `${ui}/entries/web/index.html`, to: `${renderer}/web/index.html` },
  { from: `${ui}/src/entries/web.tsx`, to: `${renderer}/web/main.tsx` },
  { from: `${ui}/entries/web/main.tsx`, to: null },
  { from: `${ui}/src/build.test.ts`, to: `${host.to}/src/build.test.ts` },
  // What built the pages there, which the app's own config does now.
  { from: `${ui}/vite.config.ts`, to: null },
]

/** Where a tracked file goes, `null` when it goes away, or undefined when it stays. */
export const destinationOf = (file: string): string | null | undefined => {
  const single = singles.find(({ from }) => from === file)
  if (single) return single.to
  return file.startsWith(`${host.from}/`) ? `${host.to}${file.slice(host.from.length)}` : undefined
}

/**
 * What the rewrite leaves as it is, and the leftover check doesn't count: by path, as each
 * stands after the move. Each names an old place on purpose.
 */
export const kept: Kept = [
  { path: "pnpm-lock.yaml", why: "pnpm install writes it again" },
  { path: "scripts/flakes/fixtures/", why: "logs captured from CI as they were" },
  { path: "FLAKY_RAPORT", why: "reports of what was" },
  { path: "scripts/packages/", why: "the move scripts and their README name the old places" },
  { path: "scripts/protocol/", why: "3.3r's move, which names the folders it moved" },
  { path: "scripts/core/", why: "3.1's and 3.2c's moves, as they ran" },
  { path: "scripts/libraries/graph.test.ts", why: "sample specs the package graph refuses" },
  { path: "scripts/libraries/fence.test.ts", why: "sample paths the fence refuses" },
]

/** Whether the rewrite reads the file at `file` (its path after the move). */
export const rewritable = (file: string): boolean => isText(file) && !keeps(kept, file)

// A path from the root, after a space, a quote, a bracket, `=`, `:` or `,`, or a relative path
// to the same folder (both sit two folders deep); and its next segment, its end, an anchor, a
// query or a sentence's full stop after it.
const lead = String.raw`(^|[\s"'\x60(\[=:,]|(?:\.\.?\/)+)`
const tail = String.raw`(?=[/"'\x60\s)\],:;#?]|\.(?:\s|$)|$)`
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const forms = [
  { pattern: new RegExp(`${lead}application\\/host${tail}`, "gm"), to: host.to },
  // Each page and file that moves on its own, by its whole path from the root.
  ...singles.flatMap(({ from, to }) =>
    to
      ? [{ pattern: new RegExp(`(^|[\\s"'\x60(\\[=:,])${escape(from)}(?![\\w.-])`, "gm"), to }]
      : [],
  ),
  {
    pattern: new RegExp(String.raw`(\\\/|^|[\s"'\x60(\[=:,])application\\\/host(?=\\\/)`, "gm"),
    to: String.raw`apps\/desktop`,
  },
]

/** The text with every path to the host's folder pointed at the desktop app's. */
export const rewrite = (text: string): string =>
  forms.reduce(
    (next, { pattern, to }) => next.replace(pattern, (_, before: string) => before + to),
    text,
  )

/**
 * The entries' imports of the UI, as the apps write them: the package's own subpaths in place
 * of the paths inside it.
 */
const entryImports = (file: string): Edit[] =>
  [
    ['import "../styles.css"', 'import "@novadeck/ui/styles.css"'],
    ['from "../app/App"', 'from "@novadeck/ui/app/App"'],
    ['from "../theme/source"', 'from "@novadeck/ui/theme/source"'],
    ['from "./start"', 'from "@novadeck/ui/entries/start"'],
  ].map(([before, after]) => ({
    file,
    before: before!,
    after: after!,
    why: "an app imports the UI by its package's subpaths",
  }))

export const edits: readonly Edit[] = [
  ...entryImports(`${renderer}/main.tsx`),
  ...entryImports(`${renderer}/web/main.tsx`),
  {
    file: `${renderer}/index.html`,
    before: '<script type="module" src="/src/entries/desktop.tsx"></script>',
    after: '<script type="module" src="./main.tsx"></script>',
    why: "the page's script is its entry, beside it",
  },
  {
    file: `${host.to}/electron-builder.yml`,
    before: "  - from: ../../frontend/ui/dist\n",
    after: "  - from: dist\n",
    why: "the desktop page is the app's own build now",
  },
  {
    file: `${host.to}/package.json`,
    before:
      '"dev": "concurrently --kill-others-on-fail --names ui,host \\"pnpm --filter @novadeck/ui dev\\" \\"electron-vite dev\\"",',
    after:
      '"dev": "concurrently --kill-others-on-fail --names ui,host \\"vite --host 127.0.0.1\\" \\"electron-vite dev\\"",',
    why: "the app serves its own page",
  },
  {
    file: `${host.to}/package.json`,
    before: '"build": "electron-vite build",',
    after: '"build": "vite build && electron-vite build",',
    why: "the app builds its page beside the main process",
  },
  {
    file: `${host.to}/package.json`,
    before: '"typecheck": "tsc --noEmit -p tsconfig.json",',
    after:
      '"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p renderer/tsconfig.json",',
    why: "the page's code has its own config, for the DOM and JSX",
  },
  {
    file: "README.md",
    before: "`pnpm --filter @novadeck/ui dev --mode web`",
    after: "`pnpm --filter @novadeck/host exec vite --host 127.0.0.1 --mode web`",
    why: "the browser app's page is the desktop app's",
  },
  {
    file: "scripts/dev-web/web.test.ts",
    before: 'expect(ui?.command).toBe("pnpm --filter @novadeck/ui dev --mode web")',
    after:
      'expect(ui?.command).toBe("pnpm --filter @novadeck/host exec vite --host 127.0.0.1 --mode web")',
    why: "as scripts/dev-web/web.ts",
  },
  {
    file: "scripts/bench/profile/app.ts",
    before: 'join(import.meta.dirname, "..", "..", "..", "application", "host")',
    after: 'join(import.meta.dirname, "..", "..", "..", "apps", "desktop")',
    why: "the packaged app's folder, joined by segment",
  },
  {
    file: "scripts/dev-web/web.ts",
    before:
      '    // The web app\'s entry (frontend/ui/entries/web), which reaches its runner over a WebSocket.\n    command: "pnpm --filter @novadeck/ui dev --mode web",',
    after:
      '    // The web app\'s entry (apps/desktop/renderer/web), which reaches its runner over a WebSocket.\n    command: "pnpm --filter @novadeck/host exec vite --host 127.0.0.1 --mode web",',
    why: "the browser app's page is the desktop app's",
  },
  {
    file: "scripts/bench/timing/stack.ts",
    before: 'const ui = join(root, "frontend/ui")',
    after: 'const ui = join(root, "apps/desktop")',
    why: "the browser app's page, which the bench builds, is the desktop app's",
  },
  {
    file: "package.json",
    before: 'pnpm --filter-prod \\"@novadeck/ui^...\\" build && node scripts/bench/timing/main.ts',
    after: 'pnpm --filter-prod \\"@novadeck/host^...\\" build && node scripts/bench/timing/main.ts',
    why: "the bench builds the browser app from the desktop app's dependencies",
  },
  {
    file: `${ui}/tsconfig.json`,
    before: '    "entries/**/*.tsx",\n',
    after: "",
    why: "the pages' scripts leave with the pages",
  },
  {
    file: `${ui}/tsconfig.json`,
    before: '    "vite.config.ts",\n',
    after: "",
    why: "the pages' build leaves with the pages",
  },
  {
    file: ".oxlintrc.json",
    before: '"files": ["frontend/*/src/**", "apps/*/src/**"],',
    // As oxfmt lays it out, so a second run finds it there.
    after:
      '"files": [\n        "frontend/*/src/**",\n        "apps/try/src/**",\n        "apps/previews/src/**",\n        "apps/desktop/renderer/**"\n      ],',
    why: "the browser's code: the desktop app's src/ is its main process, which Node runs",
  },
  // The UI's architecture test: the entries that connect to a runner leave it.
  {
    file: `${ui}/src/architecture.test.ts`,
    before:
      '  // One entry per workspace package, with the folders that own it. The content viewers serve\n  // the companion pane and chat; the runner adapter the entries that connect to a runner,\n  // which leave for apps/desktop.\n  "@novadeck/viewers": ["terminals/companion/", "terminals/chat/"],\n  "@novadeck/runner-adapter": ["entries/desktop.tsx", "entries/web.tsx"],\n',
    after:
      '  // One entry per workspace package, with the folders that own it. The content viewers serve\n  // the companion pane and chat.\n  "@novadeck/viewers": ["terminals/companion/", "terminals/chat/"],\n',
    why: "the runner adapter's entries are the desktop app's",
  },
  {
    file: `${ui}/src/architecture.test.ts`,
    before:
      '    expect(files).toEqual(\n      expect.arrayContaining(["entries/desktop.tsx", "entries/web.tsx", "entries/start.tsx"]),\n    )\n',
    after: '    expect(files).toEqual(expect.arrayContaining(["entries/start.tsx"]))\n',
    why: "start is the UI's last entry",
  },
]

/**
 * The cases a handwritten edit can't make by replacing text, which the script makes on the
 * JSON or as a whole file: each with the check that tells it is done.
 */
export const pagesTest = {
  file: `${ui}/src/architecture.test.ts`,
  // The test of the pages' scripts beside the UI's pages, which leave with them.
  start: '  it("lets each page\'s script do nothing but start its entry", () => {\n',
  end: '    expect(scripts).toEqual([["web", [`import "../../src/entries/web"`]]])\n  })\n\n',
} as const

export const svgTest = {
  file: `${ui}/src/theme/contract.test.ts`,
  start: '  it("applies only the SVG filters index.html carries", () => {\n',
  end: "    expect(used.filter((id) => !carried.has(id))).toEqual([])\n  })\n\n",
} as const

// Any mention of the old places, however written.
const leftover = new RegExp(
  [
    String.raw`application[\\/]+host\b`,
    String.raw`application\\\/host\b`,
    String.raw`["']application["'],\s*["']host["']`,
    String.raw`["']application\/["']\s*\+\s*["']host`,
    String.raw`frontend\/ui\/(?:index\.html|entries\/|src\/entries\/(?:desktop|web)\b|src\/build\.test)`,
    String.raw`--filter[= ]@novadeck\/ui (?:dev|build|preview)\b`,
  ].join("|"),
  "m",
)
const relativePath = /(?:^|[^.\w/])((?:\.\.\/)+[\w.@-]+(?:\/[\w.@-]+)*)/g
const strays = (file: string, text: string): boolean =>
  [...text.matchAll(relativePath)].some(([, path]) => {
    const landed = posix.normalize(posix.join(posix.dirname(file), path!))
    return landed === host.from || landed.startsWith(`${host.from}/`)
  })

/** The lines of a file at `file` that still name a place that moved. */
export const leftovers = (file: string, text: string): string[] =>
  keeps(kept, file)
    ? []
    : text
        .split(/\r?\n/)
        .flatMap((line, index) =>
          leftover.test(line) || strays(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        )
