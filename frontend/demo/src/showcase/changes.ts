import type { ChangedFile, ChangesContent } from "@novadeck/core/companion"

import { ready, type SampleArtifact } from "./artifacts"

// What the dev server's terminal shows of an agent's whole change, in each shape the pane
// draws: an ordinary change, files renamed, deleted and added, a binary file, one that may
// hold secrets, a change past what the runner reads, and none.

const repo = "~/projects/studio"

type Line = ChangedFile["hunks"][number]["lines"][number]
const context = (text: string): Line => ({ kind: "context", text })
const add = (text: string): Line => ({ kind: "add", text })
const remove = (text: string): Line => ({ kind: "remove", text })

const file = (
  path: string,
  status: ChangedFile["status"],
  hunks: ChangedFile["hunks"],
  rest: Partial<ChangedFile> = {},
): ChangedFile => ({
  path,
  oldPath: null,
  status,
  added: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === "add").length, 0),
  removed: hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((l) => l.kind === "remove").length,
    0,
  ),
  binary: false,
  held: false,
  listed: false,
  hunks,
  ...rest,
})

const sample = (
  id: string,
  name: string,
  detail: string,
  content: Partial<ChangesContent>,
): SampleArtifact => ({
  item: {
    id,
    kind: "changes",
    name,
    detail,
    path: `${repo}/${id}`,
    url: null,
    lines: null,
    held: false,
  },
  content: ready({
    kind: "changes",
    root: `${repo}/${id}`,
    base: "HEAD",
    files: [],
    truncated: false,
    ...content,
  }),
})

const header = file("src/components/Header.tsx", "modified", [
  {
    oldStart: 4,
    oldCount: 8,
    newStart: 4,
    newCount: 10,
    lines: [
      context("export const Header = () => ("),
      context('  <header className="site-header">'),
      remove('    <a href="/">Studio</a>'),
      add('    <a href="/" aria-label="Studio, home">'),
      add("      Studio"),
      add("    </a>"),
      context("    <nav>"),
      context('      <a href="/work">Work</a>'),
      context('      <a href="/about">About</a>'),
      context("    </nav>"),
    ],
  },
  {
    oldStart: 30,
    oldCount: 3,
    newStart: 32,
    newCount: 3,
    lines: [
      context("export default Header"),
      remove("// TODO: mobile menu"),
      add("// The mobile menu is the nav, folded."),
      context(""),
    ],
  },
])

const styles = file("src/styles/site.css", "modified", [
  {
    oldStart: 12,
    oldCount: 4,
    newStart: 12,
    newCount: 7,
    lines: [
      context(".site-header {"),
      context("  display: flex;"),
      add("  position: sticky;"),
      add("  top: 0;"),
      add("  background: var(--ivory);"),
      context("}"),
    ],
  },
])

const readme = file("README.md", "added", [
  {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 3,
    lines: [add("# Studio"), add(""), add("An independent design practice's site.")],
  },
])

export const changesArtifacts: readonly SampleArtifact[] = [
  sample("change", "Changes", "Working tree against HEAD · 3 files", {
    files: [header, styles, readme],
  }),
  sample("change-moves", "Renamed, deleted and added", "Working tree against HEAD · 3 files", {
    files: [
      file(
        "src/pages/Work.tsx",
        "renamed",
        [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 2,
            lines: [
              remove("export const Projects = () => null"),
              add("export const Work = () => null"),
            ],
          },
        ],
        { oldPath: "src/pages/Projects.tsx" },
      ),
      file("src/legacy.js", "deleted", [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 0,
          newCount: 0,
          lines: [remove("// Old build script"), remove("module.exports = {}")],
        },
      ]),
      readme,
    ],
  }),
  sample("change-binary", "A binary file", "Working tree against HEAD · 2 files", {
    files: [styles, file("public/logo.png", "modified", [], { binary: true })],
  }),
  sample("change-held", "A file that may hold secrets", "Working tree against HEAD · 2 files", {
    files: [styles, file(".env.local", "added", [], { held: true })],
  }),
  sample(
    "change-truncated",
    "A change past what is shown",
    "Working tree against HEAD · 302 files",
    {
      files: [
        header,
        ...Array.from({ length: 3 }, (_, index) =>
          file(`src/generated/part-${index + 1}.json`, "added", [], { listed: true, added: 4_000 }),
        ),
      ],
      truncated: true,
    },
  ),
  sample("change-none", "No changes", "Working tree against HEAD", {}),
]
