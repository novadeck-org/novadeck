import { isText, keeps, type Edit, type Kept } from "./move.ts"

// What step 5's 5.3a moves, and how each mention of a moved folder is rewritten: pure, so
// move-backend.ts runs it over the tree and its tests run it over text. See README.md.

/** Each folder that moves, and where. */
export const rows = [
  { from: "application/runner-client", to: "contract/runner-client" },
  { from: "application/runner", to: "backend/runner" },
  { from: "application/relay", to: "backend/relay" },
  { from: "application/protocol", to: "contract/protocol" },
  { from: "atlas", to: "tools/atlas" },
] as const

/** Where a tracked file goes, or undefined when it stays. */
export const destinationOf = (file: string): string | undefined => {
  const row = rows.find(({ from }) => file.startsWith(`${from}/`))
  return row && `${row.to}${file.slice(row.from.length)}`
}

/**
 * What the rewrite leaves as it is, and the leftover check doesn't count: by path, as each
 * stands after the move. Each names an old folder on purpose.
 */
export const kept: Kept = [
  { path: "pnpm-lock.yaml", why: "pnpm install writes it again" },
  { path: "scripts/flakes/fixtures/", why: "logs captured from CI as they were" },
  { path: "FLAKY_RAPORT", why: "reports of what was" },
  { path: "scripts/packages/", why: "this script and its README name the old folders" },
  { path: "scripts/protocol/", why: "3.3r's move, which names the folders it moved" },
  { path: "scripts/core/", why: "3.1's and 3.2c's moves, as they ran" },
  // Paths as sample text, which the tests feed in and read back the same.
  { path: "scripts/libraries/graph.test.ts", why: "sample specs the package graph refuses" },
  // Beside its own probes for the new folders, which a rewrite would duplicate.
  { path: "scripts/libraries/fence.test.ts", why: "sample paths the fence refuses" },
  { path: "backend/runner/src/terminals/peers.test.ts", why: "sample paths" },
  { path: "backend/runner/src/voice/hint.test.ts", why: "sample paths" },
  { path: "backend/runner/src/murmur/redact.test.ts", why: "sample paths" },
  { path: "backend/runner/src/murmur/description.test.ts", why: "sample paths" },
]
/** Whether the rewrite reads the file at `file` (its path after the move). */
export const rewritable = (file: string): boolean => isText(file) && !keeps(kept, file)

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// What may come before a path from the repository's root: the start of a line, a space,
// a quote, a bracket, or `=`, `:` or `,`. Relative forms (`./`, `../../`) are paths from a
// file to the folder, of the same depth wherever both stay; the atlas, one folder deeper,
// has none.
const before = String.raw`(^|[\s"'\x60(\[=:,]|(?:\.\.?\/)+)`
const rootOnly = String.raw`(^|[\s"'\x60(\[=:,])`
// What may follow it: its next segment, or the end of the path, a markdown anchor, a query or
// a sentence's full stop. Not another `.` or a `*`: `application/runner.ts` is another file, and `application/runner*` a glob
// that also took the runner client, which moves elsewhere; the leftover scan shows both.
const after = String.raw`(?=[/"'\x60\s)\],:;#?]|\.(?:\s|$)|$)`

// The atlas's folder shares its name with the atlas's own data and with a glyph atlas, so it
// is a path only where a segment follows.
const atlasAfter = "(?=/)"

const forms = rows.flatMap(({ from, to }) => {
  const atlas = from === "atlas"
  return [
    // As a path.
    {
      pattern: new RegExp(
        `${atlas ? rootOnly : before}${escape(from)}${atlas ? atlasAfter : after}`,
        "gm",
      ),
      to,
    },
    // In a regular expression, slashes escaped, as the bench's attribution reads a stack:
    // after an escaped slash, or where a path from the root may start.
    {
      pattern: new RegExp(
        `(\\\\/|${rootOnly.slice(1, -1)})${escape(from.replaceAll("/", "\\/"))}(?=\\\\/)`,
        "gm",
      ),
      to: to.replaceAll("/", "\\/"),
    },
  ]
})

/** The text with every path to a moved folder pointed at its new place. */
export const rewrite = (text: string): string =>
  forms.reduce(
    (next, { pattern, to }) => next.replace(pattern, (_, lead: string) => lead + to),
    text,
  )

export const edits: readonly Edit[] = [
  {
    file: "pnpm-workspace.yaml",
    before: "  - atlas\n",
    after: "",
    why: "tools/* takes the atlas",
  },
  {
    file: "application/host/electron-builder.yml",
    before: "  - from: ../relay/dist\n",
    after: "  - from: ../../backend/relay/dist\n",
    why: "a path from the host, one folder deeper",
  },
  {
    file: ".github/workflows/benchmark.yml",
    before: "'^(application/(ui|runner|protocol)/|",
    after: "'^(application/ui/|backend/runner/|contract/(protocol|runner-client)/|",
    why: "the folders as one alternation, the runner client the UI imports among them",
  },
  {
    file: "scripts/bench/profile/attribute.ts",
    before: String.raw`/\/application\/(?:protocol|runner-client)\/|`,
    after: String.raw`/\/contract\/(?:protocol|runner-client)\/|`,
    why: "the folders as one alternation",
  },
  {
    file: "scripts/bench/profile/attribute.test.ts",
    before: "/r/application/runner-client/",
    after: "/r/contract/runner-client/",
    why: "sample stack paths, which the attribution's patterns read",
    all: true,
  },
  {
    file: "scripts/bench/profile/attribute.test.ts",
    before: "/r/application/protocol/",
    after: "/r/contract/protocol/",
    why: "as above",
    all: true,
  },
  {
    file: "README.md",
    before: "`application/` holds\nwhat makes up the app;",
    after:
      "`application/` holds\nthe UI and the desktop host; `backend/` the runner and the relay; `contract/` the protocol\nand the runner client;",
    why: "the map's opening sentence",
  },
  {
    file: ".github/dependabot.yml",
    before: 'directory: "/application/relay"',
    after: 'directory: "/backend/relay"',
    why: "a path from the root, written with its leading slash",
  },
  {
    file: "README.md",
    before: "`tools/` holds the apps' build\nhelpers.",
    after: "`tools/` holds the apps' build\nhelpers and the atlas.",
    why: "the map's sentence on tools/",
  },
  {
    file: "README.md",
    before: "| `atlas`",
    after: "| `tools/atlas`",
    why: "the map's row for the atlas, which has no other path to match",
  },
]

// Any mention of an old folder, however it is written: wider than the rewrite, so what the
// rewrite misses shows, and so does a handwritten edit a branch's change to its line made
// stand as done (an edit is done once its old text is gone).
const leftover = new RegExp(
  [
    // From the root, with any separators, in an absolute path or a URL too.
    String.raw`application[\\/]+(?:runner|relay|protocol)\b`,
    String.raw`application\\\/(?:runner|relay|protocol)\b`,
    // In an alternation or a brace glob: `application/(ui|runner)/`, `application/{a,relay}`.
    String.raw`application\\?\/[({](?:\?:)?[^)}]*\b(?:runner|relay|protocol)\b`,
    String.raw`"application",\s*"(?:runner|relay|protocol|runner-client)"`,
    // From a sibling that stays, as the host's `../relay/dist` was.
    String.raw`(?:^|[^.\w])\.\.\/(?:runner|relay|protocol|runner-client)\/`,
    // The atlas: from the root, with a backslash, from anywhere above it, joined, in a URL.
    String.raw`(?:^|[\s"'\x60(\[=:,])atlas[\\/]`,
    String.raw`(?:\.\.\/)+atlas\/`,
    String.raw`"atlas",\s*"`,
    String.raw`\/(?:blob|tree)\/[^/\s]+\/atlas\/`,
  ].join("|"),
  "m",
)

/** The lines of a file at `file` that still name a folder that moved. */
export const leftovers = (file: string, text: string): string[] =>
  keeps(kept, file)
    ? []
    : text
        .split(/\r?\n/)
        .flatMap((line, index) =>
          leftover.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        )
